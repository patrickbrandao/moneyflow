import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

/* Variáveis de ambiente numéricas (tarefa 110): vazia = padrão; inválida ou fora da faixa impede o boot. */

const base = { DATABASE_URL: 'postgres://x' };

describe('configuração por ambiente (tarefa 110)', () => {
  it('vazio usa o padrão documentado', () => {
    const config = loadConfig({
      ...base,
      PORT: '',
      SESSION_DAYS: ' ',
      AGENT_POLL_MS: '',
      AGENT_CONCURRENCY: '',
      MESSAGE_INTERVAL_MS: '',
      TELEGRAM_TIMEOUT_MS: '',
      LOGIN_RATE_LIMIT: '',
      NOTIFY_AT: '',
      BACKUP_MAX_UPLOAD_MB: '',
      DB_STATEMENT_TIMEOUT_MS: '',
    });
    expect(config).toMatchObject({
      // Prazos do pool (tarefa 102).
      dbTimeouts: { statementTimeoutMs: 60_000, lockTimeoutMs: 30_000, idleInTransactionTimeoutMs: 300_000, connectionTimeoutMs: 10_000 },
      port: 3001,
      sessionDays: 30,
      agentPollMs: 1000,
      agentConcurrency: 4,
      messageIntervalMs: 30_000,
      telegramTimeoutMs: 10_000,
      loginRateLimit: 10,
      notifyAt: '08:00',
      backupMaxUploadBytes: 512 * 1024 * 1024,
    });
  });

  it('valor que não é inteiro, ou fora da faixa, impede o boot citando a variável', () => {
    const bad: [string, string][] = [
      ['AGENT_CONCURRENCY', 'quatro'],
      ['AGENT_CONCURRENCY', '0'],
      ['SESSION_DAYS', '30d'],
      ['SESSION_DAYS', '0'],
      ['PORT', '70000'],
      ['MESSAGE_INTERVAL_MS', '0'],
      ['WORKER_INTERVAL_MS', '1.5'],
      ['TELEGRAM_TIMEOUT_MS', 'x'],
      ['LOOKUP_TIMEOUT_MS', 'NaN'],
      ['LOGIN_RATE_LIMIT', '0'],
      ['AGENT_POLL_MS', '10'],
      ['AI_RUNS_PER_MINUTE', '5000'],
      ['AI_REQUEST_MAX_ATTEMPTS', 'três'],
      ['BACKUP_MAX_UPLOAD_MB', '-1'],
      ['SESSION_IDLE_HOURS', '-1'],
      ['DB_STATEMENT_TIMEOUT_MS', '0'],
      ['DB_LOCK_TIMEOUT_MS', '30s'],
    ];
    for (const [name, value] of bad) {
      expect(() => loadConfig({ ...base, [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
    }
    expect(() => loadConfig({ ...base, NOTIFY_AT: '8h' })).toThrow(/NOTIFY_AT/);
  });

  it('os valores do .env.example e os limites das faixas passam', () => {
    const example: Record<string, string> = {};
    for (const line of readFileSync(join(__dirname, '../../../.env.example'), 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) example[match[1]!] = match[2]!;
    }
    expect(() => loadConfig(example)).not.toThrow();
    const config = loadConfig({ ...base, AI_REQUEST_BACKOFF_MS: '0', AI_TRANSCRIPTION_TIMEOUT_MS: '0', SESSION_IDLE_HOURS: '0' });
    expect(config).toMatchObject({ aiRequestBackoffMs: 0, aiTranscriptionTimeoutMs: 0, sessionIdleHours: 0 });
  });
});

describe('.env.example da raiz (tarefa 185)', () => {
  const root = join(__dirname, '../../..');
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const names = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((m) => (m[1] ?? m[2])!));
  // As chaves do exemplo, ativas ou comentadas (`# NOME=valor`).
  const documented = names(read('.env.example'), /^#? ?([A-Z][A-Z0-9_]+)=/gm);

  it('lista toda variável lida pela configuração da API, pelo modo do processo e pelo Vite', () => {
    const code = ['apps/server/src/config.ts', 'apps/server/src/health.ts', 'apps/server/src/main.ts', 'apps/web/vite.config.ts']
      .map(read)
      .join('\n');
    const used = names(code, /env\.([A-Z][A-Z0-9_]+)|intEnv\(\s*env,\s*'([A-Z][A-Z0-9_]+)'/g);
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter((name) => !documented.has(name))).toEqual([]);
  });

  it('nenhuma chave fica sem efeito: cada uma é lida pelo código ou pelo compose da raiz', () => {
    const code = ['apps/server/src/config.ts', 'apps/server/src/health.ts', 'apps/web/vite.config.ts'].map(read).join('\n');
    // O compose do banco entra pelo include, mas a porta dele é trocada pelo docker/database.override.yml (`!override`):
    // MONEYFLOW_DB_* só valem no database/.env, para o banco de desenvolvimento.
    const dbCompose = read('database/docker-compose.yml').replace(/^\s*- "\$\{MONEYFLOW_DB_.*$/gm, '');
    const compose = [read('docker-compose.yml'), read('docker/database.override.yml'), dbCompose].join('\n');
    const effective = new Set([
      ...names(code, /env\.([A-Z][A-Z0-9_]+)|intEnv\(\s*env,\s*'([A-Z][A-Z0-9_]+)'/g),
      ...names(compose, /\$\{([A-Z][A-Z0-9_]+)/g),
    ]);
    expect([...documented].filter((name) => !effective.has(name))).toEqual([]);
  });
});
