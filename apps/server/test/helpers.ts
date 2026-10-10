import { randomUUID } from 'node:crypto';
import { createDb, createPool, type Database } from '@moneyflow/db';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { insertUser } from '../src/services/users';

export type Harness = { app: FastifyInstance; db: Database; close: () => Promise<void> };

export async function startApp(): Promise<Harness> {
  const pool = createPool(inject('databaseUrl'), 5);
  const db = createDb(pool);
  const config = loadConfig({ DATABASE_URL: inject('databaseUrl'), LOOKUP_TIMEOUT_MS: '1500' });
  const app = await buildApp({ db, config, logger: false });
  await app.ready();
  return { app, db, close: async () => { await app.close(); await pool.end(); } };
}

export const uid = () => randomUUID().slice(0, 8);

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
  const call = async <T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, expected = 200): Promise<T> => {
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
export async function scenario(h: Harness, admin: ReturnType<typeof client>) {
  const tag = uid();
  const expense = await admin.post('/api/categories', { kind: 'expense', name: `Despesa ${tag}`, colorSlot: 4 });
  const income = await admin.post('/api/categories', { kind: 'income', name: `Receita ${tag}`, colorSlot: 7 });
  const holderA = await admin.post('/api/entities', { kind: 'company', name: `Empresa A ${tag}` });
  const holderB = await admin.post('/api/entities', { kind: 'person', name: `Pessoa B ${tag}` });
  const supplier = await admin.post('/api/entities', { kind: 'company', name: `Fornecedor ${tag}` });
  const caixaA = await admin.post('/api/caixas', { name: `Caixa A ${tag}`, holderEntityId: holderA.id, isPrimary: true });
  const caixaB = await admin.post('/api/caixas', { name: `Caixa B ${tag}`, holderEntityId: holderB.id, isPrimary: true });
  const accountA = await admin.post(`/api/caixas/${caixaA.id}/accounts`, { kind: 'checking', name: 'Banco A', bankCode: '077', openingBalanceCents: 100_000, openingDate: '2026-01-01' });
  const accountB = await admin.post(`/api/caixas/${caixaB.id}/accounts`, { kind: 'cash', name: 'Cofre B', openingBalanceCents: 0, openingDate: '2026-01-01' });
  return { tag, expense, income, holderA, holderB, supplier, caixaA, caixaB, accountA, accountB };
}
