import type { Executor } from '@moneyflow/db';
import type { AiCapability } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import { findPgError } from '../errors';
import type { LlmCredentials, RequestLogBase } from './llm';

/*
 * Provedor por inferência (spec 024). O texto fica no agente
 * (ai_agents.provider_id/model); visão, embeddings, áudio→texto e texto→áudio
 * em ai_agent_inferences, com modelo e voz nulos = os padrões do provedor
 * (default_models).
 * A visão sem modelo (nem na inferência nem em default_models.vision) usa o
 * modelo de texto padrão do provedor, como sugere a tela.
 *  - resolveInference: o que está configurado, já com os padrões, sem segredo
 *    (decide visão direta, por descrição ou nenhuma; recusa imagem; par de
 *    embeddings do agente);
 *  - inferenceCredentials: a chave, só por ai_capability_credentials (exige
 *    ator, agente e provedor ativos e a flag; null quando não dá para usar).
 */

export type ResolvedInference = {
  capability: AiCapability;
  providerId: string;
  providerName: string;
  kind: 'anthropic' | 'openai';
  baseUrl: string | null;
  /** Modelo em vigor (null = nem a inferência nem o provedor têm um). */
  model: string | null;
  /** Voz em vigor (só no speech). */
  voice: string | null;
  /** Provedor ativo, não arquivado e com a flag. */
  usable: boolean;
};

type ResolvedRow = {
  provider_id: string;
  provider_name: string;
  kind: 'anthropic' | 'openai';
  base_url: string | null;
  model: string | null;
  voice: string | null;
  usable: boolean;
};

export async function resolveInference(db: Executor, agentId: string, capability: AiCapability): Promise<ResolvedInference | null> {
  const result =
    capability === 'text'
      ? await db.execute<ResolvedRow>(sql`
          SELECT p.id AS provider_id, p.name AS provider_name, p.kind, p.base_url, a.model, NULL::text AS voice,
                 (p.is_active AND p.archived_at IS NULL AND 'text' = ANY (p.capabilities)) AS usable
            FROM ai_agents a JOIN ai_providers p ON p.id = a.provider_id
           WHERE a.id = ${agentId}`)
      : await db.execute<ResolvedRow>(sql`
          SELECT p.id AS provider_id, p.name AS provider_name, p.kind, p.base_url,
                 coalesce(i.model, p.default_models ->> ${capability},
                          CASE WHEN i.capability = 'vision' THEN p.default_models ->> 'text' END) AS model,
                 CASE WHEN i.capability = 'speech' THEN coalesce(i.voice, p.default_models ->> 'speech_voice') END AS voice,
                 (p.is_active AND p.archived_at IS NULL AND ${capability} = ANY (p.capabilities)) AS usable
            FROM ai_agent_inferences i JOIN ai_providers p ON p.id = i.provider_id
           WHERE i.agent_id = ${agentId} AND i.capability = ${capability}`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    capability,
    providerId: row.provider_id,
    providerName: row.provider_name,
    kind: row.kind,
    baseUrl: row.base_url,
    model: row.model,
    voice: row.voice,
    usable: Boolean(row.usable),
  };
}

/** Como imagem e PDF chegam ao modelo de texto (spec 024). */
export type VisionMode = 'direct' | 'describe' | 'none';

/**
 * Visão direta quando o provedor de visão é o mesmo do texto (e tem a flag);
 * por descrição quando é outro; nenhuma sem provedor de visão utilizável.
 */
export async function visionMode(db: Executor, agentId: string, textProviderId: string | null): Promise<VisionMode> {
  const vision = await resolveInference(db, agentId, 'vision');
  if (!vision?.usable) return 'none';
  if (vision.providerId === textProviderId) return 'direct';
  return vision.model ? 'describe' : 'none';
}

export type InferenceCredentials = LlmCredentials & {
  providerId: string;
  model: string | null;
  voice: string | null;
  logBodies: boolean;
};

/**
 * Credenciais de uma inferência do agente para um ator (o usuário da execução,
 * ou quem fez a ação). null quando a inferência não está configurada ou não
 * pode ser usada (agente/provedor inativo, sem a flag): P0002 e 42501 do banco.
 */
export async function inferenceCredentials(
  db: Executor,
  agentId: string,
  capability: AiCapability,
  actorUserId: string,
): Promise<InferenceCredentials | null> {
  let row:
    | {
        provider_id: string;
        kind: 'anthropic' | 'openai';
        base_url: string | null;
        api_key: string | null;
        model: string | null;
        voice: string | null;
      }
    | undefined;
  try {
    const result = await db.execute<NonNullable<typeof row>>(sql`
      SELECT provider_id, kind, base_url, api_key, model, voice
        FROM ai_capability_credentials(${agentId}::uuid, ${capability}, ${actorUserId}::uuid)`);
    row = result.rows[0];
  } catch (error) {
    const code = findPgError(error)?.code;
    if (code === 'P0002' || code === '42501') return null;
    throw error;
  }
  if (!row) return null;
  const flags = await db.execute<{
    log_bodies: boolean;
    prompt_cache_enabled: boolean;
    thinking_enabled: boolean;
    text_model: string | null;
  }>(sql`
    SELECT log_bodies, prompt_cache_enabled, thinking_enabled, default_models ->> 'text' AS text_model
      FROM ai_providers WHERE id = ${row.provider_id}`);
  const f = flags.rows[0];
  return {
    providerId: row.provider_id,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    // Visão sem modelo próprio: o modelo de texto padrão do provedor (a sugestão da tela, spec 024).
    model: row.model ?? (capability === 'vision' ? (f?.text_model ?? null) : null),
    voice: row.voice,
    logBodies: Boolean(f?.log_bodies),
    promptCache: f?.prompt_cache_enabled ?? true,
    thinking: f?.thinking_enabled ?? true,
  };
}

/** Atribuição das requisições de uma inferência (spec 023). */
export function inferenceRequestLog(
  db: Executor,
  creds: { providerId: string; logBodies: boolean },
  config: Pick<Config, 'aiRequestMaxAttempts' | 'aiRequestBackoffMs'> | undefined,
  extra: Omit<RequestLogBase, 'db' | 'providerId' | 'logBodies'> = {},
): RequestLogBase {
  return {
    db,
    providerId: creds.providerId,
    logBodies: creds.logBodies,
    maxAttempts: config?.aiRequestMaxAttempts,
    backoffMs: config?.aiRequestBackoffMs,
    ...extra,
  };
}
