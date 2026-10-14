import type { Database } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { findPgError } from '../errors';
import { LlmError, transcribe } from './llm';

/*
 * Fila das transcrições (spec 025; funções da migration 0042): o upload de um
 * áudio numa conversa cujo agente converte áudio enfileira o derivado
 * transcription (pending); o worker
 *  1. reserva com ai_transcription_claim (SKIP LOCKED, transação curta, COMMIT);
 *  2. lê a chave só com a reserva (ai_transcription_credentials): 42501
 *     (provedor/dono/agente inativo) = falha; 23514/P0002 (reserva perdida,
 *     linha apagada) = descarta;
 *  3. chama o provedor pelo invólucro de requisições (spec 023), com o idioma
 *     `pt` como dica;
 *  4. grava o uso (finalidade transcription, segundos de áudio, request_id) e
 *     conclui (ai_transcription_complete) na mesma transação curta; a duração
 *     informada pelo provedor completa a do anexo, se faltava;
 *  5. erro do provedor (as novas tentativas de HTTP já ficaram no adaptador) =
 *     ai_transcription_fail, definitiva até o "tentar de novo".
 * A reserva velha (worker caiu) volta à fila sozinha depois de 10 minutos, até
 * 3 tentativas.
 */

export type ClaimedTranscription = { id: string; lock_token: string; attachment_id: string; model: string; attempts: number };

type Deps = { db: Database; config: Config; log: FastifyBaseLogger };

type Credentials = {
  provider_id: string;
  kind: 'anthropic' | 'openai';
  base_url: string | null;
  api_key: string | null;
  model: string;
  attachment_id: string;
  conversation_id: string | null;
  user_id: string | null;
  agent_id: string | null;
};

/** Reserva até `limit` transcrições (transação curta). */
export async function claimTranscriptions(db: Database, limit = 1): Promise<ClaimedTranscription[]> {
  const result = await db.execute<ClaimedTranscription>(
    sql`SELECT id, lock_token, attachment_id, model, attempts FROM ai_transcription_claim(${limit}::int)`,
  );
  return result.rows;
}

async function fail(db: Database, claimed: ClaimedTranscription, message: string) {
  await db.execute(sql`SELECT ai_transcription_fail(${claimed.id}::uuid, ${claimed.lock_token}::uuid, ${message.slice(0, 4000)})`);
}

/** Processa uma transcrição reservada. Devolve o desfecho (para os testes e o log). */
export async function processTranscription(deps: Deps, claimed: ClaimedTranscription): Promise<'done' | 'failed' | 'discarded'> {
  const { db, config, log } = deps;
  let creds: Credentials | undefined;
  try {
    const result = await db.execute<Credentials>(sql`
      SELECT provider_id, kind, base_url, api_key, model, attachment_id, conversation_id, user_id, agent_id
        FROM ai_transcription_credentials(${claimed.id}::uuid, ${claimed.lock_token}::uuid)`);
    creds = result.rows[0];
  } catch (error) {
    const pg = findPgError(error);
    if (pg?.code === '42501') {
      await fail(db, claimed, 'O provedor de áudio→texto, o agente ou o dono da conversa está inativo.');
      return 'failed';
    }
    if (pg?.code === '23514' || pg?.code === 'P0002') return 'discarded';
    throw error;
  }
  if (!creds) return 'discarded';

  const file = await db.execute<{ file_name: string; mime_type: string; content: Buffer; duration_ms: number | null }>(sql`
    SELECT file_name, mime_type, content, duration_ms FROM attachments WHERE id = ${creds.attachment_id}`);
  const audio = file.rows[0];
  if (!audio) return 'discarded';
  const flags = await db.execute<{ log_bodies: boolean }>(sql`SELECT log_bodies FROM ai_providers WHERE id = ${creds.provider_id}`);

  let outcome: Awaited<ReturnType<typeof transcribe>>;
  try {
    outcome = await transcribe(
      { kind: creds.kind, baseUrl: creds.base_url, apiKey: creds.api_key },
      creds.model,
      { fileName: audio.file_name, mime: audio.mime_type, data: Buffer.from(audio.content) },
      {
        db,
        providerId: creds.provider_id,
        userId: creds.user_id,
        agentId: creds.agent_id,
        conversationId: creds.conversation_id,
        logBodies: Boolean(flags.rows[0]?.log_bodies),
        maxAttempts: config.aiRequestMaxAttempts,
        backoffMs: config.aiRequestBackoffMs,
        log,
      },
      { language: 'pt' },
    );
  } catch (error) {
    const message = error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error);
    log.warn({ err: error, transcriptionId: claimed.id }, 'transcrição: o provedor falhou');
    await fail(db, claimed, message || 'transcription failed');
    return 'failed';
  }

  const seconds = outcome.audioSeconds !== null && Number.isFinite(outcome.audioSeconds) ? Math.max(0, outcome.audioSeconds) : 0;
  const saved = await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO ai_usage (provider_id, model, purpose, user_id, agent_id, conversation_id, input_tokens, output_tokens,
                            audio_seconds, request_id)
      VALUES (${creds.provider_id}, ${creds.model}, 'transcription', ${creds.user_id}, ${creds.agent_id}, ${creds.conversation_id},
              ${outcome.usage.inputTokens}, ${outcome.usage.outputTokens}, ${seconds.toFixed(3)}::numeric, ${outcome.requestId})`);
    const done = await tx.execute<{ ok: boolean }>(sql`
      SELECT ai_transcription_complete(${claimed.id}::uuid, ${claimed.lock_token}::uuid, ${outcome.text.slice(0, 5_000_000)}) AS ok`);
    // Duração que o navegador não informou: a do provedor.
    if (done.rows[0]?.ok && audio.duration_ms === null && seconds >= 0.001 && seconds <= 86_400) {
      await tx.execute(sql`
        UPDATE attachments SET duration_ms = ${Math.max(1, Math.round(seconds * 1000))}
         WHERE id = ${creds.attachment_id} AND duration_ms IS NULL AND mime_type ~ '^(audio|video)/'`);
    }
    return Boolean(done.rows[0]?.ok);
  });
  if (!saved) {
    log.warn({ transcriptionId: claimed.id }, 'transcrição: reserva perdida; resultado descartado');
    return 'discarded';
  }
  return 'done';
}

/** Reserva e processa até esvaziar a fila (ou `max` itens). Para os testes e para quem quer drenar. */
export async function drainTranscriptions(deps: Deps, max = 50): Promise<number> {
  let n = 0;
  while (n < max) {
    const [claimed] = await claimTranscriptions(deps.db, 1);
    if (!claimed) break;
    await processTranscription(deps, claimed);
    n += 1;
  }
  return n;
}
