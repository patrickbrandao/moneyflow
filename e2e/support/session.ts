import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Cookie, expect, type Page } from '@playwright/test';

/*
 * Sessão do admin aberta UMA vez por execução (global-setup.ts) e reaproveitada
 * pelos testes que só precisam estar logados: o POST /api/auth/login tem limite
 * por minuto (LOGIN_RATE_LIMIT, padrão 10) e a suíte inteira passaria dele.
 * O login pela tela continua coberto em fluxo-principal e contratos.
 */

export const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
export const adminUsername = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
export const adminPassword = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';
/** storageState do admin (fora do git: e2e/.auth/). */
export const ADMIN_STATE = join(import.meta.dirname, '..', '.auth', 'admin.json');

/** Cookies da sessão do admin gravada pelo global-setup. */
export function adminCookies(): Cookie[] {
  return (JSON.parse(readFileSync(ADMIN_STATE, 'utf8')) as { cookies: Cookie[] }).cookies;
}

/** Entra como admin com a sessão já aberta e espera o início. */
export async function loginAsAdmin(page: Page) {
  await page.context().addCookies(adminCookies());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
}
