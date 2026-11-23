import type { Database, Tx } from '@moneyflow/db';
import type { DeleteResult } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { ServiceContext } from '../context';
import { findPgError } from '../errors';

/*
 * Transação de escrita com o ator da auditoria (docs/016): no início de TODA
 * transação que escreve, `app.user_id` e `app.actor_kind` (e, para agentes,
 * `app.agent_run_id`) são definidos com is_local = true — valem só nesta
 * transação e não vazam pelo pool. Os triggers de audit_log e a reabertura de
 * mês (period_closings) leem esses valores. Toda escrita dos serviços passa
 * por aqui; escrita fora de transação sairia como ator `system`.
 */

export type ActorKind = 'human' | 'agent';

export async function setActor(tx: Tx, ctx: Pick<ServiceContext, 'access' | 'actorKind' | 'agentRunId'>) {
  const kind: ActorKind = ctx.actorKind ?? 'human';
  await tx.execute(sql`
    SELECT set_config('app.user_id', ${ctx.access.actor.id}, true),
           set_config('app.actor_kind', ${kind}, true),
           set_config('app.agent_run_id', ${kind === 'agent' ? (ctx.agentRunId ?? '') : ''}, true)`);
}

/** Abre a transação de escrita já com o ator definido. */
export function withTx<T>(ctx: ServiceContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await setActor(tx, ctx);
    return fn(tx);
  });
}

/** Prazos maiores que o `statement_timeout` do pool (tarefa 102), para o que de fato demora. */
export const LONG_STATEMENT_TIMEOUT = { backup: '30min', search: '5min', report: '5min' } as const;

/**
 * Leitura com prazo próprio (tarefa 102): uma transação só de leitura com o `statement_timeout` local
 * (set_config com is_local, o mesmo que SET LOCAL), que volta ao do pool no fim dela.
 */
export function longRead<T>(
  db: Database,
  timeout: string,
  fn: (tx: Tx) => Promise<T>,
  config: Omit<PgTransactionConfig, 'accessMode'> = {},
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout', ${timeout}, true)`);
      return fn(tx);
    },
    { ...config, accessMode: 'read only' },
  );
}

/**
 * Exclusão conforme a spec 008: tenta excluir num savepoint; se houver
 * vínculo (FK 23503), desfaz só o savepoint e arquiva.
 */
export async function deleteOrArchive(
  tx: Tx,
  remove: (sp: Tx) => Promise<number>,
  archive: (tx: Tx) => Promise<unknown>,
): Promise<DeleteResult> {
  try {
    const count = await tx.transaction((sp) => remove(sp));
    return { deleted: count > 0, archived: false };
  } catch (error) {
    if (findPgError(error)?.code !== '23503') throw error;
    await archive(tx);
    return { deleted: false, archived: true };
  }
}
