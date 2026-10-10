import { type Database, users } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { insertUser } from '../services/users';

/** Spec 002: cria o primeiro admin no boot a partir de ADMIN_* se não houver usuários. */
export async function ensureInitialAdmin(db: Database, config: Config, log: FastifyBaseLogger) {
  const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  if (count > 0) return;
  if (!config.admin) {
    log.warn('Nenhum usuário cadastrado e ADMIN_USERNAME/ADMIN_EMAIL/ADMIN_PASSWORD não definidos: ninguém consegue entrar.');
    return;
  }
  await insertUser(db, { ...config.admin, role: 'admin', isActive: true });
  log.info({ username: config.admin.username }, 'Admin inicial criado.');
}
