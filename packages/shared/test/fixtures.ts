import { readFileSync } from 'node:fs';

/** Fixtures fictícias compartilhadas com os testes do servidor. */
export const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../apps/server/test/fixtures/${name}`, import.meta.url)));

export const fixtureText = (name: string): string =>
  readFileSync(new URL(`../../../apps/server/test/fixtures/${name}`, import.meta.url), 'utf8');
