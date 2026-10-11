import { t } from '@moneyflow/shared';

/**
 * Identidade do MoneyFlow. Trocar aqui muda a sidebar, o login, a aba do
 * navegador e o prefixo de tudo que vai para o localStorage.
 *
 * Ao mudar `storagePrefix`, mude também a chave lida pelo script inline do
 * `index.html` (ela é `${storagePrefix}:theme`).
 */
export const BRAND = {
  name: t.app.name,
  subtitle: t.app.subtitle,
  logoUrl: '/logo.svg',
  homePath: '/',
  storagePrefix: 'moneyflow',
  defaultTheme: 'dark' as 'dark' | 'light',
} as const;

export const storageKey = (name: string) => `${BRAND.storagePrefix}:${name}`;

export const THEME_STORAGE_KEY = storageKey('theme');
