import type { Database, pg } from '@moneyflow/db';
import { t } from '@moneyflow/shared';
import { AppError } from '../../errors';

/*
 * "Uma operação de backup por vez" (spec 019, tarefa 172): uma trava só, no
 * banco, para o dump, a restauração, o JSON completo e a importação. O dump, a
 * restauração e o JSON completo seguram a trava consultiva de sessão numa
 * conexão própria do pool até o fim (vale entre processos e réplicas); a
 * importação pega a mesma chave como trava de transação
 * (`pg_try_advisory_xact_lock`), que conflita com a de sessão. O psql da
 * restauração roda noutra sessão e não pega a chave: a trava da API já cobre o
 * processo filho.
 */

/** A chave da trava, em SQL (a mesma nas duas formas). */
export const BACKUP_LOCK_KEY = "hashtext('moneyflow:backup')";

/** Outra operação de backup em andamento. */
export const backupBusy = () => new AppError(409, 'backup_busy', t.backup.errors.busy);

/** Roda `fn` com a trava do backup; sem ela (outra operação em andamento, aqui ou noutra réplica), 409. */
export async function withBackupLock<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  // O pool por trás do Drizzle (`drizzle(pool)` o guarda em `$client`): a trava de sessão precisa de uma conexão só.
  const pool = (db as unknown as { $client: pg.Pool }).$client;
  const client = await pool.connect();
  let locked = false;
  let broken = false;
  try {
    const result = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${BACKUP_LOCK_KEY}) AS ok`);
    locked = result.rows[0]?.ok === true;
    if (!locked) throw backupBusy();
    return await fn();
  } finally {
    if (locked) {
      // Sem conseguir soltar, a conexão é descartada: a trava de sessão morre com ela.
      await client.query(`SELECT pg_advisory_unlock(${BACKUP_LOCK_KEY})`).catch(() => {
        broken = true;
      });
    }
    client.release(broken || undefined);
  }
}
