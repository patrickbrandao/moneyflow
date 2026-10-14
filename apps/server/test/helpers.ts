import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, createPool, type Database, pg } from '@moneyflow/db';
import { cnpjCheckDigits } from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { insertUser } from '../src/services/users';
import { migrate } from './migrate';

export type Harness = { app: FastifyInstance; db: Database; config: Config; close: () => Promise<void> };

export async function startApp(env: Record<string, string> = {}, databaseUrl = inject('databaseUrl')): Promise<Harness> {
  const pool = createPool(databaseUrl, 5);
  const db = createDb(pool);
  const config = loadConfig({ DATABASE_URL: databaseUrl, LOOKUP_TIMEOUT_MS: '1500', LOGIN_RATE_LIMIT: '10000', ...env });
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
 * importar num sistema limpo). Devolve a conexão como moneyflow_app, ou null
 * sem a conexão do dono (MONEYFLOW_TEST_OWNER_URL no modo de banco externo).
 */
export async function freshDatabase(): Promise<string | null> {
  const owner = inject('ownerDatabaseUrl');
  if (!owner) return null;
  const name = `moneyflow_bk_${uid().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: owner });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const ownerUrl = new URL(owner);
  ownerUrl.pathname = `/${name}`;
  await migrate(ownerUrl.toString());
  const appUrl = new URL(inject('databaseUrl'));
  appUrl.pathname = `/${name}`;
  return appUrl.toString();
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
