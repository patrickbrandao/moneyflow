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
  /** Consulta de CNPJ no CNPJ Aberto (spec 003), ligada por CNPJ_ABERTO_ENABLED; null = só BrasilAPI. A chave nunca vai a logs. */
  cnpjAberto: { base: string; apiKey: string } | null;
  /** URL base da BrasilAPI (consulta de CNPJ padrão e fallback do CNPJ Aberto; troque por um mock nos testes). */
  brasilApiBase: string;
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
  /** Agentes (spec 011): intervalo de busca de execuções na fila, em ms. */
  agentPollMs: number;
  /** Execuções de agente simultâneas por worker. */
  agentConcurrency: number;
  /** Manutenção dos agentes (retenção de eventos, expiração de confirmações, embeddings), em ms. */
  agentMaintenanceMs: number;
  /** Agente usado nos fluxos (leitura de documento, sugestões da conciliação), pelo nome; vazio = o primeiro ativo. */
  aiFlowAgent: string | null;
  /** Espera máxima da leitura de documento por IA, em ms. */
  aiDocumentTimeoutMs: number;
  /** Backup (spec 019): conexão do dono do banco, só para pg_dump/pg_restore; null = dump e restauração desligados. */
  ownerDatabaseUrl: string | null;
  /** Pasta dos binários do cliente PostgreSQL (pg_dump, pg_restore); vazia = PATH. */
  pgBinDir: string | null;
  /** Tamanho máximo do arquivo enviado na importação/restauração, em bytes. */
  backupMaxUploadBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL não definida (conexão como moneyflow_app).');
  const admin =
    env.ADMIN_USERNAME && env.ADMIN_EMAIL && env.ADMIN_PASSWORD
      ? { username: env.ADMIN_USERNAME, email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }
      : null;
  const cnpjAbertoKey = env.CNPJ_ABERTO_API_KEY?.trim();
  if (env.CNPJ_ABERTO_ENABLED === 'true' && !cnpjAbertoKey)
    throw new Error('CNPJ_ABERTO_ENABLED=true exige CNPJ_ABERTO_API_KEY (veja .env.example).');
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
    cnpjAberto:
      env.CNPJ_ABERTO_ENABLED === 'true' && cnpjAbertoKey
        ? { base: (env.CNPJ_ABERTO_BASE || 'https://cnpjaberto.com.br').replace(/\/+$/, ''), apiKey: cnpjAbertoKey }
        : null,
    brasilApiBase: (env.BRASILAPI_BASE || 'https://brasilapi.com.br').replace(/\/+$/, ''),
    logLevel: env.LOG_LEVEL ?? 'info',
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
    cardAutoClose: env.CARD_AUTO_CLOSE === 'true',
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    telegramTimeoutMs: Number(env.TELEGRAM_TIMEOUT_MS ?? 10_000),
    messageIntervalMs: Number(env.MESSAGE_INTERVAL_MS ?? 30_000),
    publicUrl: env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : null,
    notifyAt: /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(env.NOTIFY_AT ?? '') ? env.NOTIFY_AT! : '08:00',
    agentPollMs: Number(env.AGENT_POLL_MS ?? 1000),
    agentConcurrency: Math.max(1, Number(env.AGENT_CONCURRENCY ?? 4)),
    agentMaintenanceMs: Number(env.AGENT_MAINTENANCE_MS ?? 5 * 60 * 1000),
    aiFlowAgent: env.AI_FLOW_AGENT?.trim() || null,
    aiDocumentTimeoutMs: Number(env.AI_DOCUMENT_TIMEOUT_MS ?? 120_000),
    ownerDatabaseUrl: env.DATABASE_OWNER_URL?.trim() || null,
    pgBinDir: env.PG_BIN_DIR?.trim() || null,
    backupMaxUploadBytes: Math.max(1, Number(env.BACKUP_MAX_UPLOAD_MB ?? 512)) * 1024 * 1024,
  };
}
