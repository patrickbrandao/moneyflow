/** Configuração por variáveis de ambiente (veja .env.example na raiz). */
export type Config = {
  databaseUrl: string;
  host: string;
  port: number;
  cookieSecure: boolean;
  sessionDays: number;
  /** Ociosidade máxima da sessão, em horas (SESSION_IDLE_HOURS, padrão 72; 0 desliga): sem uso nesse tempo, a sessão cai (tarefa 066). */
  sessionIdleHours: number;
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
  /**
   * Proxies reversos que podem informar o IP do cliente pelo X-Forwarded-For (TRUSTED_PROXIES:
   * IPs, CIDRs ou loopback/linklocal/uniquelocal, separados por vírgula). Vazio = não confiar em
   * nenhum: o IP é o da conexão (tarefa 050).
   */
  trustedProxies: string[];
  /** Worker fecha sozinho as faturas de cartão na data de fechamento (padrão: só sugere; fechamento manual). */
  cardAutoClose: boolean;
  /** URL base da Bot API do Telegram (troque por um mock nos testes). */
  telegramApiBase: string;
  telegramTimeoutMs: number;
  /** Intervalo do laço de mensagens do worker (produtor de eventos, notificações e consumo da outbox), em ms. */
  messageIntervalMs: number;
  /** URL pública do console, para os links nas mensagens (vazia = mensagens sem link). */
  publicUrl: string | null;
  /** URL pública HTTPS da API para o webhook do Telegram (spec 029); app_settings telegram.public_base_url vence. */
  publicBaseUrl: string | null;
  /** Intervalo do laço das tarefas agendadas dos agentes (spec 029), em ms. */
  agentTaskIntervalMs: number;
  /** Horário (HH:MM, São Paulo) dos avisos diários do sino (vencem hoje, atrasados). */
  notifyAt: string;
  /** Agentes (spec 011): intervalo de busca de execuções na fila, em ms. */
  agentPollMs: number;
  /** Execuções de agente simultâneas por worker. */
  agentConcurrency: number;
  /** Manutenção dos agentes (retenção de eventos, expiração de confirmações, embeddings), em ms. */
  agentMaintenanceMs: number;
  /** Espera máxima da leitura de documento por IA, em ms (esgotada, a execução é cancelada: tarefa 150). */
  aiDocumentTimeoutMs: number;
  /** Espera máxima da conversão do PDF do contrato em markdown, em ms (mais longa: a saída é o documento inteiro). */
  aiDocumentConvertTimeoutMs: number;
  /** Teto do tamanho estimado de uma chamada ao modelo, em bytes (tarefa 098): acima dele, falha sem chamar. */
  aiRequestMaxBytes: number;
  /** Requisições ao provedor (spec 023): tentativas do próprio MoneyFlow por chamada (padrão 3). */
  aiRequestMaxAttempts: number;
  /** Base do backoff entre as tentativas, em ms (1 s, 2 s, 4 s…; menor nos testes). */
  aiRequestBackoffMs: number;
  /** Retenção padrão das requisições, em dias (app_settings ai.request_retention_days vence). */
  aiRequestRetentionDays: number;
  /** Limite por minuto (spec 028): execuções de IA por usuário nas sessões (app_settings ai.runs_per_minute vence). */
  aiRunsPerMinute: number;
  /** Execuções por minuto por usuário nos fluxos automáticos (app_settings ai.flow_runs_per_minute vence). */
  aiFlowRunsPerMinute: number;
  /** Chat multimídia (spec 025): espera máxima da execução pelas transcrições pendentes da mensagem, em ms. */
  aiTranscriptionTimeoutMs: number;
  /** Backup (spec 019): conexão do dono do banco, só para pg_dump/pg_restore; null = dump e restauração desligados. */
  ownerDatabaseUrl: string | null;
  /** Pasta dos binários do cliente PostgreSQL (pg_dump, pg_restore); vazia = PATH. */
  pgBinDir: string | null;
  /** Tamanho máximo do arquivo enviado na importação/restauração, em bytes. */
  backupMaxUploadBytes: number;
  /**
   * Prazo da parada (SIGTERM/SIGINT), em ms (tarefa 107): o worker devolve à fila as execuções de agente
   * no meio da chamada ao modelo e espera as passadas em andamento até ele; passado o prazo (mais uma
   * folga), o processo sai mesmo assim. Padrão 8 s, abaixo dos 10 s do `docker stop`.
   */
  shutdownGraceMs: number;
};

/**
 * Inteiro da variável de ambiente (tarefa 110): vazia ou ausente = o padrão; qualquer outra coisa
 * que não seja um inteiro dentro da faixa impede o boot com a mensagem que cita a variável. Antes,
 * `Number(env.X ?? padrão)` virava 0 (vazia) ou NaN (`30d`) em silêncio.
 */
export function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} precisa ser um inteiro entre ${min} e ${max} (veja .env.example); recebido "${raw.slice(0, 40)}".`);
  }
  return n;
}

const HOUR_MS = 3_600_000;

/**
 * Aviso do boot (tarefa 066): a URL pública do console em HTTPS com o cookie de sessão sem `Secure`
 * (COOKIE_SECURE=false) deixa o cookie ir em texto claro se alguém abrir o endereço em HTTP.
 */
export function insecureCookieWarning(config: Pick<Config, 'cookieSecure' | 'publicUrl' | 'publicBaseUrl'>): string | null {
  if (config.cookieSecure) return null;
  const https = [config.publicBaseUrl, config.publicUrl].find((url) => url?.toLowerCase().startsWith('https://'));
  if (!https) return null;
  return `COOKIE_SECURE=false com a URL pública em HTTPS (${https}): o cookie de sessão sai sem Secure. Defina COOKIE_SECURE=true atrás de HTTPS.`;
}

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
    port: intEnv(env, 'PORT', 3001, 1, 65_535),
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionDays: intEnv(env, 'SESSION_DAYS', 30, 1, 3650),
    // 0 desliga a ociosidade.
    sessionIdleHours: intEnv(env, 'SESSION_IDLE_HOURS', 72, 0, 87_600),
    webDist: env.WEB_DIST ?? null,
    admin,
    workerIntervalMs: intEnv(env, 'WORKER_INTERVAL_MS', HOUR_MS, 1000, 24 * HOUR_MS),
    lookupTimeoutMs: intEnv(env, 'LOOKUP_TIMEOUT_MS', 5000, 100, 120_000),
    cnpjAberto:
      env.CNPJ_ABERTO_ENABLED === 'true' && cnpjAbertoKey
        ? { base: (env.CNPJ_ABERTO_BASE || 'https://cnpjaberto.com.br').replace(/\/+$/, ''), apiKey: cnpjAbertoKey }
        : null,
    brasilApiBase: (env.BRASILAPI_BASE || 'https://brasilapi.com.br').replace(/\/+$/, ''),
    logLevel: env.LOG_LEVEL ?? 'info',
    loginRateLimit: intEnv(env, 'LOGIN_RATE_LIMIT', 10, 1, 1_000_000),
    trustedProxies: (env.TRUSTED_PROXIES ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    cardAutoClose: env.CARD_AUTO_CLOSE === 'true',
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    telegramTimeoutMs: intEnv(env, 'TELEGRAM_TIMEOUT_MS', 10_000, 100, 300_000),
    messageIntervalMs: intEnv(env, 'MESSAGE_INTERVAL_MS', 30_000, 1000, HOUR_MS),
    publicUrl: env.APP_URL ? env.APP_URL.replace(/\/+$/, '') : null,
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim() ? env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '') : null,
    agentTaskIntervalMs: intEnv(env, 'AGENT_TASK_INTERVAL_MS', 30_000, 1000, HOUR_MS),
    notifyAt: notifyAt(env.NOTIFY_AT),
    agentPollMs: intEnv(env, 'AGENT_POLL_MS', 1000, 100, 60_000),
    agentConcurrency: intEnv(env, 'AGENT_CONCURRENCY', 4, 1, 64),
    agentMaintenanceMs: intEnv(env, 'AGENT_MAINTENANCE_MS', 5 * 60 * 1000, 1000, 24 * HOUR_MS),
    aiDocumentTimeoutMs: intEnv(env, 'AI_DOCUMENT_TIMEOUT_MS', 120_000, 1000, 1_800_000),
    aiDocumentConvertTimeoutMs: intEnv(env, 'AI_DOCUMENT_CONVERT_TIMEOUT_MS', 300_000, 1000, 1_800_000),
    aiRequestMaxBytes: intEnv(env, 'AI_REQUEST_MAX_BYTES', 30 * 1024 * 1024, 10_000, 512 * 1024 * 1024),
    aiRequestMaxAttempts: intEnv(env, 'AI_REQUEST_MAX_ATTEMPTS', 3, 1, 10),
    aiRequestBackoffMs: intEnv(env, 'AI_REQUEST_BACKOFF_MS', 1000, 0, 60_000),
    aiRequestRetentionDays: intEnv(env, 'AI_REQUEST_RETENTION_DAYS', 30, 1, 365),
    aiRunsPerMinute: intEnv(env, 'AI_RUNS_PER_MINUTE', 10, 1, 1000),
    aiFlowRunsPerMinute: intEnv(env, 'AI_FLOW_RUNS_PER_MINUTE', 30, 1, 1000),
    aiTranscriptionTimeoutMs: intEnv(env, 'AI_TRANSCRIPTION_TIMEOUT_MS', 120_000, 0, 600_000),
    ownerDatabaseUrl: env.DATABASE_OWNER_URL?.trim() || null,
    pgBinDir: env.PG_BIN_DIR?.trim() || null,
    backupMaxUploadBytes: intEnv(env, 'BACKUP_MAX_UPLOAD_MB', 512, 1, 4096) * 1024 * 1024,
    shutdownGraceMs: intEnv(env, 'SHUTDOWN_GRACE_MS', 8000, 1000, 600_000),
  };
}

/** Horário dos avisos diários do sino (HH:MM): vazio = 08:00; fora do formato impede o boot (tarefa 110). */
function notifyAt(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return '08:00';
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
    throw new Error(`NOTIFY_AT precisa ser um horário HH:MM (veja .env.example); recebido "${value.slice(0, 20)}".`);
  }
  return value;
}
