import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { request } from '@playwright/test';
import { ADMIN_STATE, adminPassword, adminUsername, baseURL } from './support/session';

/** Abre a sessão do admin uma vez e a grava para os testes (ver support/session.ts). */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.post('/api/auth/login', { data: { login: adminUsername, password: adminPassword } });
    if (!res.ok()) throw new Error(`login do admin no global-setup falhou: ${res.status()} ${await res.text()}`);
    mkdirSync(dirname(ADMIN_STATE), { recursive: true });
    await ctx.storageState({ path: ADMIN_STATE });
  } finally {
    await ctx.dispose();
  }
}
