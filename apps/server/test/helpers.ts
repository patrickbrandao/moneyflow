import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, createPool, type Database, pg } from '@moneyflow/db';
import { cnpjCheckDigits } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { stopRun } from '../src/services/conversations';
import { insertUser } from '../src/services/users';
import { createOwnedDatabase, migrate, withDatabase } from './migrate';

export type Harness = { app: FastifyInstance; db: Database; config: Config; close: () => Promise<void> };

export async function startApp(env: Record<string, string> = {}, databaseUrl = inject('databaseUrl')): Promise<Harness> {
  const pool = createPool(databaseUrl, 5);
  const db = createDb(pool);
  // Execuções de IA por minuto (spec 028) folgadas: os testes mandam muitas mensagens com o mesmo usuário.
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    LOOKUP_TIMEOUT_MS: '1500',
    LOGIN_RATE_LIMIT: '10000',
    AI_RUNS_PER_MINUTE: '1000',
    AI_FLOW_RUNS_PER_MINUTE: '1000',
    ...env,
  });
  const app = await buildApp({ db, config, logger: false });
  await app.ready();
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export const uid = () => randomUUID().slice(0, 8);

/** CNPJ alfanumérico fictício e válido (base aleatória [0-9A-Z]{12} + DV), já normalizado. */
export function alphaCnpj(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = randomBytes(12);
  // Começa com letra e dígito: é de fato alfanumérico e qualquer prefixo de 2+ caracteres tem os dois.
  const base = `${chars[10 + (bytes[0]! % 26)]}${bytes[1]! % 10}${Array.from(bytes.subarray(2), (b) => chars[b % 36]).join('')}`;
  return `${base}${cnpjCheckDigits(base)}`;
}

/**
 * Um banco novo e vazio no mesmo servidor, migrado do zero (testes de backup:
 * importar num sistema limpo, ida e volta do dump). Criado como no initdb
 * (tarefa 054): pelo superusuário, com dono moneyflow_owner e as extensões, e
 * migrado pelo dono. Com `migrateAs: 'super'`, o arranjo antigo (e o da
 * produção de hoje): o banco do superusuário, migrado por ele. Devolve as
 * conexões como moneyflow_app (`app`), do dono das migrations (`owner`) e do
 * superusuário (`super`), ou null sem a conexão do dono
 * (MONEYFLOW_TEST_OWNER_URL no modo de banco externo).
 */
const freshNames: string[] = [];

export async function freshDatabaseUrls(
  options: { migrateAs?: 'owner' | 'super' } = {},
): Promise<{ app: string; owner: string; super: string } | null> {
  const owner = inject('ownerDatabaseUrl');
  if (!owner) return null;
  // Sem o superusuário (banco externo sem MONEYFLOW_TEST_SUPER_URL), a conexão do dono cria os bancos.
  const superUrl = inject('superDatabaseUrl') || owner;
  const name = `moneyflow_bk_${uid().replace(/-/g, '')}`;
  const byOwnerRole = superUrl !== owner && options.migrateAs !== 'super';
  if (byOwnerRole) {
    await createOwnedDatabase(superUrl, name);
  } else {
    const admin = new pg.Client({ connectionString: superUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
  }
  freshNames.push(name);
  const urls = {
    app: withDatabase(inject('databaseUrl'), name),
    owner: withDatabase(byOwnerRole ? owner : superUrl, name),
    super: withDatabase(superUrl, name),
  };
  await migrate(urls.owner);
  return urls;
}

/** Um banco novo e migrado (veja freshDatabaseUrls): a conexão como moneyflow_app, ou null. */
export async function freshDatabase(): Promise<string | null> {
  return (await freshDatabaseUrls())?.app ?? null;
}

/**
 * Apaga os bancos criados por freshDatabase() (chame no afterAll, depois de
 * fechar os harnesses). Contra um banco externo (MONEYFLOW_TEST_OWNER_URL)
 * eles sobrariam no servidor; no Testcontainers somem com o container.
 */
export async function dropFreshDatabases() {
  const owner = inject('ownerDatabaseUrl');
  if (!owner || freshNames.length === 0) return;
  const admin = new pg.Client({ connectionString: inject('superDatabaseUrl') || owner });
  await admin.connect();
  try {
    for (const name of freshNames.splice(0)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Cria um usuário direto no banco e devolve o cookie de sessão dele. */
export async function userSession(h: Harness, role: 'admin' | 'user' = 'user') {
  const username = `${role}-${uid()}`;
  const password = `senha-${uid()}`;
  const id = await insertUser(h.db, { username, email: `${username}@teste.local`, password, role, isActive: true });
  const cookie = await login(h, username, password);
  return { id, username, password, cookie };
}

export async function login(h: Harness, loginName: string, password: string) {
  const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: loginName, password } });
  if (res.statusCode !== 200) throw new Error(`login falhou: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'mf_session');
  return `mf_session=${cookie!.value}`;
}

/** Atalho de chamada autenticada que falha com o corpo da resposta se o status não for o esperado. */
export function client(h: Harness, cookie: string) {
  const call = async <T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    expected = 200,
  ): Promise<T> => {
    const res = await h.app.inject({ method, url, payload: payload as object, headers: { cookie } });
    if (res.statusCode !== expected) throw new Error(`${method} ${url} → ${res.statusCode} (esperado ${expected}): ${res.body}`);
    return res.json() as T;
  };
  return {
    get: <T = any>(url: string, expected?: number) => call<T>('GET', url, undefined, expected),
    post: <T = any>(url: string, body?: unknown, expected?: number) => call<T>('POST', url, body ?? {}, expected),
    patch: <T = any>(url: string, body?: unknown, expected?: number) => call<T>('PATCH', url, body ?? {}, expected),
    put: <T = any>(url: string, body?: unknown, expected?: number) => call<T>('PUT', url, body ?? {}, expected),
    del: <T = any>(url: string, expected?: number) => call<T>('DELETE', url, undefined, expected),
    raw: (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      h.app.inject({ method, url, payload: payload as object, headers: { cookie } }),
  };
}

/** Cenário básico: categorias de despesa/receita, entidades titulares, caixas e contas. */
export async function scenario(_h: Harness, admin: ReturnType<typeof client>) {
  const tag = uid();
  const expense = await admin.post('/api/categories', { kind: 'expense', name: `Despesa ${tag}`, colorSlot: 4 });
  const income = await admin.post('/api/categories', { kind: 'income', name: `Receita ${tag}`, colorSlot: 7 });
  const holderA = await admin.post('/api/entities', { kind: 'company', name: `Empresa A ${tag}` });
  const holderB = await admin.post('/api/entities', { kind: 'person', name: `Pessoa B ${tag}` });
  const supplier = await admin.post('/api/entities', { kind: 'company', name: `Fornecedor ${tag}` });
  const caixaA = await admin.post('/api/caixas', { name: `Caixa A ${tag}`, holderEntityId: holderA.id, isPrimary: true });
  const caixaB = await admin.post('/api/caixas', { name: `Caixa B ${tag}`, holderEntityId: holderB.id, isPrimary: true });
  const accountA = await admin.post(`/api/caixas/${caixaA.id}/accounts`, {
    kind: 'checking',
    name: 'Banco A',
    bankCode: '077',
    openingBalanceCents: 100_000,
    openingDate: '2026-01-01',
  });
  const accountB = await admin.post(`/api/caixas/${caixaB.id}/accounts`, {
    kind: 'cash',
    name: 'Cofre B',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });
  return { tag, expense, income, holderA, holderB, supplier, caixaA, caixaB, accountA, accountB };
}

/** PDF mínimo válido com uma camada de texto (uma linha por item), para a extração no servidor (spec 024). */
export function minimalPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** PNG 1×1 (anexo de imagem dos testes). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Sessão nova com o agente (spec 026): finaliza a sessão ativa do par, se
 * houver (parando a execução), e abre outra. Os testes que querem começar do
 * zero usam isto; a API recusa uma 2ª sessão ativa do mesmo usuário e agente.
 */
export async function newSession(api: ReturnType<typeof client>, agentId: string) {
  const threads = await api.get<{ agentId: string; active: { id: string } | null }[]>('/api/agents/threads');
  const active = threads.find((thread) => thread.agentId === agentId)?.active;
  if (active) await api.post(`/api/conversations/${active.id}/finish`);
  return api.post('/api/conversations', { agentId });
}

/**
 * Encerra as execuções de agente que os arquivos anteriores deixaram na fila ou
 * esperando confirmação. Os arquivos rodam em sequência no mesmo banco, e o
 * `ai_run_claim(1, …)` dos `drain()` pega a execução mais antiga de qualquer
 * arquivo: uma sobra (o `classify_lines` de outro arquivo, por exemplo) gastaria
 * o `llm.queue` do teste, conforme a ordem do vitest. Chame no `beforeAll`,
 * depois do `startApp`.
 */
export async function stopLeftoverRuns(h: Harness) {
  const left = await h.db.execute<{ id: string; conversation_id: string }>(
    sql`SELECT id, conversation_id FROM ai_runs WHERE status IN ('queued', 'awaiting_confirmation') ORDER BY created_at`,
  );
  for (const run of left.rows) await h.db.transaction((tx) => stopRun(tx, run.id, run.conversation_id));
}

/**
 * Cancela as mensagens que os arquivos anteriores deixaram na fila do Telegram.
 * O `consumeOutbox` reserva as mais antigas de qualquer destino, até 50 por
 * passada: com a fila cheia de sobras, a mensagem do teste fica para depois e o
 * envio esperado não acontece. Chame no `beforeAll`, depois do `startApp`, nos
 * arquivos que consomem a fila.
 */
export async function cancelLeftoverMessages(h: Harness) {
  await h.db.execute(
    sql`UPDATE message_outbox SET status = 'canceled', last_error = coalesce(last_error, 'canceled_by_test') WHERE status = 'pending'`,
  );
}
