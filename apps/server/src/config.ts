/** Configuração por variáveis de ambiente (veja .env.example na raiz). */
export type Config = {
  databaseUrl: string;
  host: string;
  port: number;
  cookieSecure: boolean;
  sessionDays: number;
  webDist: string | null;
  admin: { username: string; email: string; password: string } | null;
  workerIntervalMs: number;
  lookupTimeoutMs: number;
  logLevel: string;
  /** Tentativas de login por minuto por IP. */
  loginRateLimit: number;
  /** Worker fecha sozinho as faturas de cartão na data de fechamento (padrão: só sugere; fechamento manual). */
  cardAutoClose: boolean;
  /** URL base da Bot API do Telegram (troque por um mock nos testes). */
  telegramApiBase: string;
  telegramTimeoutMs: number;
  /** Intervalo do laço de mensagens do worker (produtor de eventos, notificações e consumo da outbox), em ms. */
  messageIntervalMs: number;
  /** URL pública do console, para os links nas mensagens (vazia = mensagens sem link). */
  publicUrl: string | null;
  /** Horário (HH:MM, São Paulo) dos avisos diários do sino (vencem hoje, atrasados). */
  notifyAt: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL não definida (conexão como moneyflow_app).');
  const admin =
    env.ADMIN_USERNAME && env.ADMIN_EMAIL && env.ADMIN_PASSWORD
      ? { username: env.ADMIN_USERNAME, email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }
      : null;
  return {
    databaseUrl,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3001),
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    webDist: env.WEB_DIST ?? null,
    admin,
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 60 * 60 * 1000),
    lookupTimeoutMs: Number(env.LOOKUP_TIMEOUT_MS ?? 5000),
    logLevel: env.LOG_LEVEL ?? 'info',
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
    cardAutoClose: env.CARD_AUTO_CLOSE === 'true',
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    telegramTimeoutMs: Number(env.TELEGRAM_TIMEOUT_MS ?? 10_000),
    messageIntervalMs: Number(env.MESSAGE_INTERVAL_MS ?? 30_000),
    publicUrl: env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : null,
    notifyAt: /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(env.NOTIFY_AT ?? '') ? env.NOTIFY_AT! : '08:00',
  };
}
