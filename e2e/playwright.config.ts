import { defineConfig, devices } from '@playwright/test';

/*
 * E2E contra uma instância já no ar (padrão: a pilha da raiz,
 * `docker compose up --build -d` → http://localhost:3000). Credenciais do
 * admin: E2E_USERNAME/E2E_PASSWORD, ou ADMIN_USERNAME/ADMIN_PASSWORD.
 */
export default defineConfig({
  testDir: './tests',
  // Uma sessão do admin para a suíte toda (o login tem limite por minuto): support/session.ts.
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } }],
});
