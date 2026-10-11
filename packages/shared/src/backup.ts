/*
 * Backup e restauração (spec 019). O arquivo de exportação é um JSON com as
 * linhas de cada tabela (colunas do banco, em snake_case) e, nas exportações
 * por recurso, as referências externas usadas só para casar registros na
 * importação (nunca inseridas).
 */

export const BACKUP_FORMAT = 'moneyflow-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Recursos com exportação e importação próprias (telas de Administração → Backup e restauração). */
export const BACKUP_RESOURCES = ['categories', 'entities', 'caixas', 'ai-providers', 'users'] as const;
export type BackupResource = (typeof BACKUP_RESOURCES)[number];
/** O que um arquivo de backup contém: um recurso ou o conteúdo completo. */
export type BackupKind = BackupResource | 'full';

export const isBackupKind = (value: string): value is BackupKind =>
  value === 'full' || (BACKUP_RESOURCES as readonly string[]).includes(value);

export type BackupRow = Record<string, unknown>;

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  kind: BackupKind;
  /** Última migration aplicada no banco de origem (nulo sem dbmate). */
  schemaVersion: string | null;
  exportedAt: string;
  exportedBy: string;
  tables: Record<string, BackupRow[]>;
  /** Registros referenciados fora do recurso, só para casar na importação. */
  references?: Record<string, BackupRow[]>;
};

/** Situação de um registro do arquivo depois da importação. */
export type ImportItemStatus = 'imported' | 'existing' | 'skipped' | 'failed';

export type ImportIssue = {
  table: string;
  id: string;
  label: string;
  status: Exclude<ImportItemStatus, 'imported'>;
  reason: string;
};

export type ImportTableSummary = {
  table: string;
  total: number;
  imported: number;
  existing: number;
  skipped: number;
  failed: number;
};

export type ImportReport = {
  kind: BackupKind;
  dryRun: boolean;
  /** Versão do schema de origem e a deste banco (aviso quando diferem). */
  sourceSchemaVersion: string | null;
  schemaVersion: string | null;
  summary: ImportTableSummary[];
  issues: ImportIssue[];
  /** Total de itens não importados (issues pode vir truncado). */
  issueCount: number;
  truncated: boolean;
  /** Tabelas do arquivo que este sistema não conhece ou não importa. */
  ignoredTables: string[];
  durationMs: number;
};

export type BackupStatus = {
  schemaVersion: string | null;
  /** Dump e restauração do PostgreSQL disponíveis (conexão do dono e pg_dump configurados). */
  dumpAvailable: boolean;
  /** Por que o dump não está disponível (pt-BR). */
  dumpUnavailableReason: string | null;
  /** Versão do pg_dump encontrada. */
  pgDumpVersion: string | null;
  maxUploadBytes: number;
};

export type DumpRestoreResult = {
  restored: true;
  schemaVersion: string | null;
  exportedAt: string | null;
  durationMs: number;
};

/** Palavra que o admin digita para confirmar a restauração do dump (destrói o banco atual). */
export const DUMP_RESTORE_CONFIRMATION = 'RESTAURAR';
