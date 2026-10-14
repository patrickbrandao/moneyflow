import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ADMIN_TOOLS,
  type AiAgentDto,
  type AiBudgetDto,
  agentTool,
  aiAgentCreateInput,
  aiAgentUpdateInput,
  aiPriceInput,
  aiProviderCreateInput,
  aiProviderUpdateInput,
  budgetScopeLabel,
  destinationCreateInput,
  destinationUpdateInput,
  diffRows,
  formatDate,
  formatFileSize,
  formatMicros,
  type ImportReport,
  mcpServerCreateInput,
  mcpServerUpdateInput,
  type PreviewField,
  type PreviewRow,
  type ToolPreview,
  type ToolSecretField,
  t,
  toMicros,
  userCreateInput,
  userUpdateInput,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { badRequest, forbidden, notFound, unprocessable } from '../errors';
import * as aiAdmin from '../services/ai-admin';
import * as aiBudgets from '../services/ai-budgets';
import * as aiRequests from '../services/ai-requests';
import * as apiTokens from '../services/api-tokens';
import * as audit from '../services/audit';
import { backupStatus, createDumpZip } from '../services/backup/dump';
import { backupStamp, exportFullZip, exportResource } from '../services/backup/export';
import { importBackup, parseBackupUpload } from '../services/backup/import';
import * as caixas from '../services/caixas';
import * as entityTags from '../services/entity-tags';
import * as messages from '../services/messages';
import { listNotifications } from '../services/notifications';
import * as users from '../services/users';
import { type GeneratedFile, type Handlers, nameOf, toolAttachment } from './tool-helpers';

/*
 * Executores do lote F13b (spec 027): Configuração de IA, Usuários e
 * permissões (com os tokens pessoais), Backup, Fechamento e auditoria,
 * Mensagens e as tags de entidade. Mesmos serviços das rotas (com Access); as
 * prévias conferem a permissão antes de pedir aprovação.
 *
 * Segredos: as tools com `secrets` declaram os campos na prévia
 * (`secretFields`) e recebem os valores em `meta.secrets` — digitados no
 * cartão e trazidos pela requisição de decisão, nunca pelo modelo. Elas rodam
 * só na API (executeSecretTool), e o worker nunca as executa.
 */

type AdminToolName = (typeof ADMIN_TOOLS)[number]['name'];

/* ---------------- orçamentos ---------------- */

const BUDGET_WARNING =
  'A 100% do valor, novas execuções que o orçamento cobre são recusadas até o mês seguinte (o administrador que aciona fica isento).';

async function userName(ctx: ServiceContext, id: string) {
  const r = await ctx.db.execute<{ username: string }>(sql`SELECT username FROM users WHERE id = ${id}`);
  if (!r.rows[0]) throw notFound();
  return r.rows[0].username;
}
async function agentNameOf(ctx: ServiceContext, id: string) {
  const r = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM ai_agents WHERE id = ${id}`);
  if (!r.rows[0]) throw notFound(t.agents.errors.agentNotFound);
  return r.rows[0].name;
}
const budgetPreviewValues = (b: AiBudgetDto) => ({
  limit: formatMicros(b.monthlyLimitMicros, b.currency),
  currency: b.currency,
  alert: `${b.alertPercent}%`,
  active: b.isActive,
});

const listed = (items: string[], max = 12) =>
  items.length > max ? `${items.slice(0, max).join(', ')} e mais ${items.length - max}` : items.join(', ') || '—';
const yesNo = (v: boolean) => (v ? 'Sim' : 'Não');
const COLOR = (v: unknown) => `Cor ${v}`;

/* ---------------- segredos ---------------- */

const secretField = (key: string, label: string, required: boolean, hint?: string): ToolSecretField => ({
  key,
  label,
  required,
  ...(hint ? { hint } : {}),
});
const API_KEY_FIELD = (update: boolean) =>
  secretField('apiKey', 'Chave da API', false, update ? 'Vazio mantém a chave atual.' : 'Vazio = sem chave (servidor sem autenticação).');
const BOT_TOKEN_FIELD = (update: boolean) =>
  update
    ? secretField('botToken', 'Token do bot', false, 'Vazio mantém o token atual.')
    : secretField('botToken', 'Token do bot', true, 'Formato <id>:<chave>, do @BotFather.');
const PASSWORD_FIELD = secretField('password', 'Senha', true, 'Mínimo de 6 caracteres.');
const HEADER_KEY = (name: string) => `header:${name}`;
const headerFields = (names: string[], update: boolean) =>
  names.map((name) => secretField(HEADER_KEY(name), `Cabeçalho ${name}`, false, update ? 'Vazio mantém o valor atual.' : undefined));
/** Valores dos cabeçalhos digitados no cartão (só os preenchidos). */
const typedHeaders = (names: string[], secrets: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(names.filter((name) => secrets?.[HEADER_KEY(name)]).map((name) => [name, secrets![HEADER_KEY(name)]!]));

/* ---------------- mensagens ---------------- */

const OWNER_KIND = (v: unknown) => ({ user: 'Pessoal', caixa: 'Da caixa', global: 'Global (todos)' })[String(v)] ?? String(v);

async function manageableDestination(ctx: ServiceContext, destinationId: string) {
  const destination = await messages.getDestination(ctx, destinationId);
  if (!destination.canManage) throw forbidden(destination.ownerKind === 'global' ? t.errors.destinationGlobalAdmin : undefined);
  return destination;
}

/* ---------------- usuários ---------------- */

const ROLE = (v: unknown) => (v === 'admin' ? 'Administrador' : v === 'user' ? 'Usuário' : String(v));
const CAIXA_ROLE = (v: unknown) => (v === 'editor' ? 'Editor (lê e escreve)' : v === 'viewer' ? 'Leitor (só lê)' : String(v));
const USER_FIELDS: PreviewField[] = [
  { key: 'username', label: 'Login' },
  { key: 'email', label: 'E-mail' },
  { key: 'role', label: 'Papel', format: ROLE },
  { key: 'isActive', label: 'Ativo', format: 'bool' },
];

async function memberOf(ctx: ServiceContext, caixaId: string, userId: string) {
  return (await caixas.listMembers(ctx, caixaId)).find((m) => m.userId === userId) ?? null;
}

/* ---------------- configuração de IA ---------------- */

const PROVIDER_FIELDS: PreviewField[] = [
  { key: 'name', label: 'Nome' },
  { key: 'kind', label: 'Tipo', format: (v) => (v === 'anthropic' ? 'Anthropic' : 'OpenAI') },
  { key: 'baseUrl', label: 'Base URL' },
  { key: 'capabilities', label: 'Capacidades', format: (v) => (v as string[]).map((c) => t.agents.capabilities[c] ?? c).join(', ') },
  {
    key: 'defaultModels',
    label: 'Modelos padrão',
    format: (v) =>
      Object.entries(v as Record<string, string>)
        .map(([k, m]) => `${t.agents.capabilities[k] ?? k}: ${m}`)
        .join(' · ') || '—',
  },
  { key: 'promptCacheEnabled', label: 'Cache de prompt', format: 'bool' },
  { key: 'thinkingEnabled', label: 'Raciocínio', format: 'bool' },
  { key: 'isActive', label: 'Ativo', format: 'bool' },
  { key: 'logBodies', label: 'Registrar corpos', format: 'bool' },
  { key: 'notes', label: 'Observações' },
];

const PRICE = (v: unknown) => (v === null || v === undefined ? '—' : String(v));

async function agentById(ctx: ServiceContext, agentId: string): Promise<AiAgentDto> {
  const agent = (await aiAdmin.listAgents(ctx)).find((a) => a.id === agentId);
  if (!agent) throw notFound(t.agents.errors.agentNotFound);
  return agent;
}

async function providerName(ctx: ServiceContext, providerId: string | null | undefined) {
  if (!providerId) return null;
  return (await aiAdmin.getProvider(ctx.db, providerId).catch(() => null))?.name ?? providerId;
}

async function kitName(ctx: ServiceContext, kitId: string | null | undefined) {
  if (!kitId) return 'Sem kit (todas as tools, sem aprovação)';
  return (await aiAdmin.getToolKit(ctx, kitId)).name;
}

/** Valores do agente legíveis para o diff (nomes no lugar dos ids). */
async function agentValues(ctx: ServiceContext, values: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...values };
  if ('providerId' in values) out.providerId = (await providerName(ctx, values.providerId as string | null)) ?? '—';
  if ('toolKitId' in values) out.toolKitId = await kitName(ctx, values.toolKitId as string | null);
  if ('systemPrompt' in values && typeof values.systemPrompt === 'string') {
    const prompt = values.systemPrompt;
    out.systemPrompt = prompt.length > 160 ? `${prompt.slice(0, 160)}… (${prompt.length} caracteres)` : prompt || '—';
  }
  if (Array.isArray(values.inferences)) {
    out.inferences =
      (values.inferences as { capability: string }[]).map((x) => t.agents.capabilities[x.capability] ?? x.capability).join(', ') || '—';
  }
  if (Array.isArray(values.mcpServers)) out.mcpServers = `${(values.mcpServers as unknown[]).length} servidor(es)`;
  return out;
}

const AGENT_FIELDS: PreviewField[] = [
  { key: 'name', label: 'Nome' },
  { key: 'description', label: 'Descrição' },
  { key: 'providerId', label: 'Provedor' },
  { key: 'model', label: 'Modelo' },
  { key: 'systemPrompt', label: 'Prompt' },
  { key: 'toolKitId', label: 'Kit de ferramentas' },
  { key: 'inferences', label: 'Inferências' },
  { key: 'mcpServers', label: 'Servidores MCP' },
  { key: 'colorSlot', label: 'Cor', format: COLOR },
  { key: 'isActive', label: 'Ativo', format: 'bool' },
  { key: 'useForFlows', label: 'Usar nos fluxos automáticos', format: 'bool' },
];

/** Tools do kit validadas contra o registro (a de segredo fica em ask). */
function kitRows(tools: { name: string; mode: 'allow' | 'ask' }[]): PreviewRow[] {
  const unknown = tools.filter((x) => !agentTool(x.name)).map((x) => x.name);
  if (unknown.length > 0) throw badRequest(t.agents.errors.toolUnknown(unknown.join(', ')));
  const allow = tools.filter((x) => x.mode === 'allow' && !agentTool(x.name)!.secrets?.length).map((x) => x.name);
  const ask = tools.filter((x) => !allow.includes(x.name)).map((x) => x.name);
  return [
    { label: 'Ferramentas', after: String(tools.length) },
    ...(allow.length ? [{ label: 'Sem aprovação (allow)', after: listed(allow, 20) }] : []),
    ...(ask.length ? [{ label: 'Com aprovação (ask)', after: listed(ask, 20) }] : []),
  ];
}

async function mcpById(ctx: ServiceContext, serverId: string) {
  const server = (await aiAdmin.listMcpServers(ctx)).find((s) => s.id === serverId);
  if (!server) throw notFound();
  return server;
}

const MCP_FIELDS: PreviewField[] = [
  { key: 'name', label: 'Nome' },
  { key: 'url', label: 'URL' },
  {
    key: 'visibility',
    label: 'Visibilidade',
    format: (v) => ({ global: 'Global', public: 'Pública', private: 'Privada' })[String(v)] ?? String(v),
  },
  {
    key: 'instructionsMode',
    label: 'Instruções do servidor',
    format: (v) => ({ ignore: 'Ignorar', system: 'No prompt de sistema', user: 'Bloco do usuário' })[String(v)] ?? String(v),
  },
  { key: 'isActive', label: 'Ativo', format: 'bool' },
  { key: 'notes', label: 'Observações' },
];

/* ---------------- backup ---------------- */

const BACKUP_LABEL: Record<string, string> = {
  categories: 'Categorias (JSON)',
  entities: 'Entidades (JSON)',
  caixas: 'Caixas (JSON)',
  'ai-providers': 'Provedores de IA (JSON, com as chaves)',
  users: 'Usuários (JSON, com as senhas)',
  full: 'Conteúdo completo (.zip)',
  dump: 'Dump do PostgreSQL (.zip)',
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Gera um arquivo num diretório temporário, lê (até 20 MB) e apaga. */
async function tempFile(fileName: string, produce: (path: string) => Promise<void>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'moneyflow-agent-'));
  try {
    const path = join(dir, fileName);
    await produce(path);
    const size = (await stat(path)).size;
    if (size > MAX_FILE_BYTES) throw unprocessable(t.agents.errors.fileTooLarge(formatFileSize(size)), 'file_too_large');
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exportFile(ctx: ServiceContext, what: string): Promise<GeneratedFile> {
  const stamp = backupStamp();
  if (what === 'full') {
    const fileName = `moneyflow-completo-${stamp}.zip`;
    return { fileName, mime: 'application/zip', content: await tempFile(fileName, (path) => exportFullZip(ctx, path)) };
  }
  if (what === 'dump') {
    const fileName = `moneyflow-dump-${stamp}.zip`;
    const log = { error: () => {} };
    return { fileName, mime: 'application/zip', content: await tempFile(fileName, (path) => createDumpZip(ctx, path, log)) };
  }
  const file = await exportResource(ctx, what as Parameters<typeof exportResource>[1]);
  return {
    fileName: `moneyflow-${what}-${stamp}.json`,
    mime: 'application/json',
    content: Buffer.from(JSON.stringify(file, null, 2), 'utf8'),
  };
}

/** Relatório da importação para o modelo: o resumo e no máximo 50 itens não importados. */
const reportForModel = (report: ImportReport) => ({
  kind: report.kind,
  dryRun: report.dryRun,
  sourceSchemaVersion: report.sourceSchemaVersion,
  schemaVersion: report.schemaVersion,
  summary: report.summary,
  issueCount: report.issueCount,
  issues: report.issues.slice(0, 50),
  ignoredTables: report.ignoredTables,
});

async function importFrom(ctx: ServiceContext, attachmentId: string, dryRun: boolean) {
  ctx.access.assertAdmin();
  const file = await toolAttachment(ctx, attachmentId);
  const backup = parseBackupUpload(file.content);
  return importBackup(ctx, backup, backup.kind, dryRun);
}

function importRows(report: ImportReport): PreviewRow[] {
  return report.summary
    .filter((s) => s.total > 0)
    .map((s) => ({
      label: t.audit.tables[s.table] ?? t.backup.tables[s.table] ?? s.table,
      after: `${s.imported} entram · ${s.existing} já existem · ${s.skipped + s.failed} não entram`,
    }));
}

/* ---------------- handlers ---------------- */

export const ADMIN_HANDLERS: Handlers<AdminToolName> = {
  /* ---- tags de entidade ---- */
  create_entity_tag: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      return {
        title: 'Criar tag de entidade',
        summary: i.name,
        action: 'create',
        rows: [
          { label: 'Nome', after: i.name },
          { label: 'Cor', after: COLOR(i.colorSlot) },
        ],
      };
    },
    run: (ctx, i) => entityTags.createTag(ctx, i),
  },
  update_entity_tag: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const tag = (await entityTags.listTags(ctx, { archived: true })).find((x) => x.id === i.tagId);
      if (!tag) throw notFound();
      return {
        title: 'Editar tag de entidade',
        summary: tag.name,
        action: 'update',
        rows: diffRows(
          [
            { key: 'name', label: 'Nome' },
            { key: 'colorSlot', label: 'Cor', format: COLOR },
          ],
          i.changes,
          tag as unknown as Record<string, unknown>,
        ),
      };
    },
    run: (ctx, i) => entityTags.updateTag(ctx, i.tagId, i.changes),
  },
  archive_entity_tag: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const tag = (await entityTags.listTags(ctx, { archived: true })).find((x) => x.id === i.tagId);
      if (!tag) throw notFound();
      if (tag.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar tag de entidade',
        summary: tag.name,
        action: 'delete',
        rows: [{ label: 'Entidades com a tag', after: String(tag.usageCount) }],
        warnings: [
          tag.usageCount > 0
            ? 'Em uso: a tag é arquivada (continua nas entidades, sai do seletor e do filtro).'
            : 'Sem uso: a tag é excluída.',
        ],
      };
    },
    run: (ctx, i) => entityTags.deleteTag(ctx, i.tagId),
  },

  /* ---- mensagens ---- */
  list_message_subscriptions: { run: (ctx, i) => messages.listSubscriptions(ctx, i.destinationId) },
  create_message_destination: {
    preview: async (ctx, i) => {
      if (i.ownerKind === 'global' && !ctx.access.isAdmin) throw forbidden(t.errors.destinationGlobalAdmin);
      if (i.ownerKind === 'caixa') {
        if (!i.ownerCaixaId) throw badRequest(t.errors.destinationOwner);
        ctx.access.assertWrite(i.ownerCaixaId);
      }
      return {
        title: 'Criar destino do Telegram',
        summary: i.name,
        action: 'create',
        rows: [
          { label: 'Nome', after: i.name },
          { label: 'Dono', after: OWNER_KIND(i.ownerKind) },
          ...(i.ownerCaixaId ? [{ label: 'Caixa', after: (await nameOf(ctx, 'caixa', i.ownerCaixaId)) ?? '' }] : []),
          { label: 'Chat', after: i.chatId },
          { label: 'Ativo', after: yesNo(i.isActive) },
          { label: 'Token do bot', after: 'digitado no cartão' },
        ],
        secretFields: [BOT_TOKEN_FIELD(false)],
      };
    },
    run: (ctx, i, meta) => messages.createDestination(ctx, destinationCreateInput.parse({ ...i, botToken: meta.secrets?.botToken ?? '' })),
  },
  update_message_destination: {
    preview: async (ctx, i) => {
      const before = await manageableDestination(ctx, i.destinationId);
      if (before.archivedAt) throw unprocessable(t.errors.destinationArchived);
      return {
        title: 'Editar destino do Telegram',
        summary: before.name,
        action: 'update',
        rows: diffRows(
          [
            { key: 'name', label: 'Nome' },
            { key: 'chatId', label: 'Chat' },
            { key: 'isActive', label: 'Ativo', format: 'bool' },
            { key: 'notes', label: 'Observações' },
          ],
          i.changes,
          before as unknown as Record<string, unknown>,
        ),
        secretFields: [BOT_TOKEN_FIELD(true)],
      };
    },
    run: (ctx, i, meta) =>
      messages.updateDestination(ctx, i.destinationId, destinationUpdateInput.parse({ ...i.changes, botToken: meta.secrets?.botToken })),
  },
  archive_message_destination: {
    preview: async (ctx, i) => {
      const destination = await manageableDestination(ctx, i.destinationId);
      if (destination.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar destino do Telegram',
        summary: destination.name,
        action: 'delete',
        rows: [
          { label: 'Dono', after: OWNER_KIND(destination.ownerKind) },
          { label: 'Assinaturas', after: String(destination.subscriptions) },
        ],
        warnings: ['Com histórico de envios, o destino é arquivado e desativado (as pendentes são canceladas); sem histórico, é excluído.'],
      };
    },
    run: (ctx, i) => messages.deleteDestination(ctx, i.destinationId),
  },
  set_message_subscriptions: {
    preview: async (ctx, i) => {
      const destination = await manageableDestination(ctx, i.destinationId);
      if (destination.archivedAt) throw unprocessable(t.errors.destinationArchived);
      for (const sub of i.subscriptions) for (const caixaId of sub.caixaIds) ctx.access.assertRead(caixaId);
      const current = new Map((await messages.listSubscriptions(ctx, i.destinationId)).map((s) => [s.eventKind, s]));
      const event = (kind: string) => t.messages.events[kind] ?? kind;
      return {
        title: 'Definir assinaturas do destino',
        summary: destination.name,
        action: 'update',
        rows: [
          ...i.subscriptions.map((s) => ({
            label: event(s.eventKind),
            ...(current.has(s.eventKind) ? { before: current.get(s.eventKind)!.isActive ? 'Ativa' : 'Inativa' } : {}),
            after: `${s.isActive ? 'Ativa' : 'Inativa'}${Object.keys(s.params).length ? ` · ${JSON.stringify(s.params)}` : ''}`,
          })),
          ...i.remove.map((kind) => ({ label: event(kind), before: current.has(kind) ? 'Assinada' : 'Não assinada', after: 'Removida' })),
        ],
      };
    },
    run: async (ctx, i) => {
      for (const sub of i.subscriptions) await messages.upsertSubscription(ctx, i.destinationId, sub);
      for (const kind of i.remove) await messages.deleteSubscription(ctx, i.destinationId, kind);
      return messages.listSubscriptions(ctx, i.destinationId);
    },
  },
  send_test_message: {
    preview: async (ctx, i) => {
      const destination = await manageableDestination(ctx, i.destinationId);
      if (destination.archivedAt) throw unprocessable(t.errors.destinationArchived);
      if (!destination.isActive) throw unprocessable(t.errors.destinationInactive);
      return {
        title: 'Enviar mensagem de teste',
        summary: destination.name,
        action: 'send',
        rows: [{ label: 'Chat', after: destination.chatId }],
      };
    },
    run: (ctx, i) => messages.sendTest(ctx, i.destinationId),
  },
  list_notifications: { run: (ctx, i) => listNotifications(ctx, { unread: i.unread, limit: i.limit }) },

  /* ---- fechamento e auditoria ---- */
  list_month_closings: { run: (ctx, i) => audit.closingsOverview(ctx, i.caixaId) },
  close_month: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.caixaId);
      const overview = await audit.closingsOverview(ctx, i.caixaId);
      if (overview.closings.some((c) => c.month === i.month)) throw unprocessable('Este mês já está fechado nesta caixa.', 'month_closed');
      const pending = overview.unreconciled.find((u) => u.month === i.month)?.lines ?? 0;
      if (pending > 0 && !i.force) throw unprocessable(t.errors.closingUnreconciled(pending), 'closing_unreconciled');
      return {
        title: 'Fechar mês',
        summary: `${(await nameOf(ctx, 'caixa', i.caixaId)) ?? ''} · ${formatDate(i.month).slice(3)}`,
        action: 'create',
        rows: [{ label: 'Mês', before: 'Aberto', after: 'Fechado' }, ...(i.notes ? [{ label: 'Observações', after: i.notes }] : [])],
        warnings: [
          'Lançamentos com data neste mês ficam bloqueados (só o administrador reabre).',
          ...(pending > 0 ? [`${pending} linha(s) de extrato do mês ainda não conciliadas (fechando mesmo assim).`] : []),
        ],
      };
    },
    run: (ctx, i) => audit.closeMonth(ctx, i.caixaId, { month: i.month, notes: i.notes, force: i.force }),
  },
  reopen_month: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const overview = await audit.closingsOverview(ctx, i.caixaId);
      if (!overview.closings.some((c) => c.month === i.month)) throw notFound();
      return {
        title: 'Reabrir mês',
        summary: `${(await nameOf(ctx, 'caixa', i.caixaId)) ?? ''} · ${formatDate(i.month).slice(3)}`,
        action: 'delete',
        rows: [{ label: 'Mês', before: 'Fechado', after: 'Aberto' }],
        warnings: ['Os lançamentos do mês voltam a poder ser alterados.'],
      };
    },
    run: (ctx, i) => audit.reopenMonth(ctx, i.caixaId, i.month),
  },
  get_audit_history: { run: (ctx, i) => audit.recordHistory(ctx, i.table, i.recordId) },

  /* ---- usuários e permissões ---- */
  list_users: {
    run: async (ctx, i) => {
      const q = i.q?.toLowerCase();
      const all = await users.listUsers(ctx);
      return (q ? all.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) : all).slice(0, i.limit);
    },
  },
  create_user: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      return {
        title: 'Criar usuário',
        summary: i.username,
        action: 'create',
        rows: [...diffRows(USER_FIELDS, i), { label: 'Senha', after: 'digitada no cartão' }],
        secretFields: [PASSWORD_FIELD],
      };
    },
    run: (ctx, i, meta) => users.createUser(ctx, userCreateInput.parse({ ...i, password: meta.secrets?.password ?? '' })),
  },
  update_user: {
    preview: async (ctx, i) => {
      const before = await users.getUser(ctx, i.userId);
      return {
        title: 'Editar usuário',
        summary: before.username,
        action: 'update',
        rows: diffRows(USER_FIELDS, i.changes, before as unknown as Record<string, unknown>),
      };
    },
    run: (ctx, i) => users.updateUser(ctx, i.userId, i.changes),
  },
  set_user_active: {
    preview: async (ctx, i) => {
      const before = await users.getUser(ctx, i.userId);
      if (i.userId === ctx.access.actor.id && !i.active) throw unprocessable(t.errors.selfDeactivate);
      return {
        title: i.active ? 'Ativar usuário' : 'Desativar usuário',
        summary: before.username,
        action: 'update',
        rows: [{ label: 'Ativo', before: yesNo(before.isActive), after: yesNo(i.active) }],
        warnings: i.active ? [] : ['As sessões do usuário são encerradas.'],
      };
    },
    run: (ctx, i) => users.updateUser(ctx, i.userId, { isActive: i.active }),
  },
  set_user_password: {
    preview: async (ctx, i) => {
      const user = await users.getUser(ctx, i.userId);
      return {
        title: 'Trocar a senha do usuário',
        summary: user.username,
        action: 'update',
        rows: [{ label: 'Senha', before: '•••', after: 'digitada no cartão' }],
        warnings: i.userId === ctx.access.actor.id ? [] : ['As sessões do usuário são encerradas.'],
        secretFields: [PASSWORD_FIELD],
      };
    },
    run: async (ctx, i, meta) => {
      const user = await users.updateUser(ctx, i.userId, userUpdateInput.parse({ password: meta.secrets?.password ?? '' }));
      return { id: user.id, username: user.username };
    },
  },
  list_caixa_members: { run: (ctx, i) => caixas.listMembers(ctx, i.caixaId) },
  set_caixa_member: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const user = await users.getUser(ctx, i.userId);
      const current = await memberOf(ctx, i.caixaId, i.userId);
      return {
        title: current ? 'Trocar o papel na caixa' : 'Dar acesso à caixa',
        summary: `${user.username} · ${(await nameOf(ctx, 'caixa', i.caixaId)) ?? ''}`,
        action: current ? 'update' : 'create',
        rows: [{ label: 'Papel', ...(current ? { before: CAIXA_ROLE(current.role) } : {}), after: CAIXA_ROLE(i.role) }],
      };
    },
    run: async (ctx, i) => {
      const current = await memberOf(ctx, i.caixaId, i.userId);
      if (current) return caixas.updateMember(ctx, i.caixaId, current.id, { role: i.role });
      return caixas.addMember(ctx, i.caixaId, { userId: i.userId, role: i.role });
    },
  },
  remove_caixa_member: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const current = await memberOf(ctx, i.caixaId, i.userId);
      if (!current) throw notFound();
      return {
        title: 'Tirar acesso à caixa',
        summary: `${current.username} · ${(await nameOf(ctx, 'caixa', i.caixaId)) ?? ''}`,
        action: 'delete',
        rows: [{ label: 'Papel', before: CAIXA_ROLE(current.role), after: 'Sem acesso' }],
      };
    },
    run: async (ctx, i) => {
      const current = await memberOf(ctx, i.caixaId, i.userId);
      if (!current) throw notFound();
      return caixas.removeMember(ctx, i.caixaId, current.id);
    },
  },
  list_api_tokens: { run: (ctx) => apiTokens.listApiTokens(ctx) },
  revoke_api_token: {
    preview: async (ctx, i) => {
      const token = (await apiTokens.listApiTokens(ctx)).find((x) => x.id === i.tokenId);
      if (!token) throw notFound();
      if (token.revokedAt) throw unprocessable('O token já está revogado.', 'token_revoked');
      return {
        title: 'Revogar token de API',
        summary: `${token.name} (${token.tokenPrefix}…)`,
        action: 'delete',
        rows: [{ label: 'Situação', before: 'Ativo', after: 'Revogado' }],
        warnings: ['Quem usa este token (o servidor /mcp) perde o acesso na hora.'],
      };
    },
    run: (ctx, i) => apiTokens.revokeApiToken(ctx, i.tokenId),
  },

  /* ---- configuração de IA: provedores ---- */
  list_ai_providers: { run: (ctx) => aiAdmin.listProviders(ctx) },
  create_ai_provider: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      // Valida como a rota (inclusive as regras entre campos), sem a chave.
      const full = aiProviderCreateInput.parse({ ...i, apiKey: null });
      return {
        title: 'Criar provedor de IA',
        summary: i.name,
        action: 'create',
        rows: [...diffRows(PROVIDER_FIELDS, full), { label: 'Chave da API', after: 'digitada no cartão' }],
        secretFields: [API_KEY_FIELD(false)],
      };
    },
    run: (ctx, i, meta) => aiAdmin.createProvider(ctx, aiProviderCreateInput.parse({ ...i, apiKey: meta.secrets?.apiKey ?? null })),
  },
  update_ai_provider: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const before = await aiAdmin.getProvider(ctx.db, i.providerId);
      const rows = diffRows(PROVIDER_FIELDS, i.changes as Record<string, unknown>, before as unknown as Record<string, unknown>);
      if (i.changes.clearApiKey) rows.push({ label: 'Chave da API', before: before.apiKeyHint ?? '—', after: 'apagada' });
      return {
        title: 'Editar provedor de IA',
        summary: before.name,
        action: 'update',
        rows,
        ...(i.changes.clearApiKey ? {} : { secretFields: [API_KEY_FIELD(true)] }),
      };
    },
    run: (ctx, i, meta) =>
      aiAdmin.updateProvider(
        ctx,
        i.providerId,
        aiProviderUpdateInput.parse({ ...i.changes, apiKey: i.changes.clearApiKey ? undefined : meta.secrets?.apiKey }),
      ),
  },
  archive_ai_provider: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const provider = await aiAdmin.getProvider(ctx.db, i.providerId);
      if (provider.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar provedor de IA',
        summary: provider.name,
        action: 'delete',
        rows: [{ label: 'Ativo', before: yesNo(provider.isActive), after: 'Não' }],
        warnings: ['Em uso (agentes, preços ou uso registrado), o provedor é arquivado e desativado; sem uso, é excluído.'],
      };
    },
    run: (ctx, i) => aiAdmin.deleteProvider(ctx, i.providerId),
  },
  test_provider: { run: (ctx, i) => aiAdmin.testProvider(ctx, i.providerId) },
  list_provider_models: { run: (ctx, i) => aiAdmin.listProviderModels(ctx, i.providerId) },

  /* ---- preços ---- */
  list_ai_prices: { run: (ctx) => aiAdmin.listPrices(ctx) },
  create_ai_price: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const provider = await aiAdmin.getProvider(ctx.db, i.providerId);
      const parsed = aiPriceInput.parse(i);
      return {
        title: 'Cadastrar preço de modelo',
        summary: `${provider.name} · ${i.model}`,
        action: 'create',
        rows: [
          { label: 'Moeda', after: parsed.currency },
          { label: 'Entrada (por milhão)', after: PRICE(parsed.inputPricePerMillion) },
          { label: 'Saída (por milhão)', after: PRICE(parsed.outputPricePerMillion) },
          { label: 'Escrita no cache (por milhão)', after: PRICE(parsed.cacheWritePricePerMillion) },
          { label: 'Leitura do cache (por milhão)', after: PRICE(parsed.cacheReadPricePerMillion) },
          { label: 'Áudio→texto (por minuto)', after: PRICE(parsed.audioInputPerMinute) },
          { label: 'Texto→áudio (por milhão de caracteres)', after: PRICE(parsed.speechPerMillionChars) },
          { label: 'Vale a partir de', after: parsed.validFrom ?? 'agora' },
        ],
      };
    },
    run: (ctx, i) => aiAdmin.createPrice(ctx, i),
  },
  delete_ai_price: {
    preview: async (ctx, i) => {
      const price = (await aiAdmin.listPrices(ctx)).find((p) => p.id === i.priceId);
      if (!price) throw notFound();
      return {
        title: 'Excluir preço de modelo',
        summary: `${price.providerName} · ${price.model}`,
        action: 'delete',
        rows: [
          {
            label: 'Entrada / saída (por milhão)',
            before: `${price.inputPricePerMillion} / ${price.outputPricePerMillion} ${price.currency}`,
            after: '—',
          },
          { label: 'Vale a partir de', before: price.validFrom, after: '—' },
        ],
        warnings: ['O custo do uso passa a seguir o preço anterior do modelo, se houver.'],
      };
    },
    run: (ctx, i) => aiAdmin.deletePrice(ctx, i.priceId),
  },

  /* ---- agentes ---- */
  list_ai_agents: { run: (ctx) => aiAdmin.listAgents(ctx) },
  create_ai_agent: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const parsed = aiAgentCreateInput.parse(i);
      const values = await agentValues(ctx, {
        ...parsed,
        providerId: parsed.providerId ?? parsed.defaultProviderId ?? null,
      });
      const warnings: string[] = [];
      if (parsed.useForFlows) warnings.push('Só um agente atende os fluxos automáticos: o atual deixa de ser.');
      if (!parsed.toolKitId) warnings.push('Sem kit: o agente tem todas as tools, sem pedir aprovação (salvo as de segredo).');
      return { title: 'Criar agente', summary: i.name, action: 'create', rows: diffRows(AGENT_FIELDS, values), warnings };
    },
    run: (ctx, i) => aiAdmin.createAgent(ctx, i),
  },
  update_ai_agent: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const before = await agentById(ctx, i.agentId);
      const changes = aiAgentUpdateInput.parse(i.changes) as Record<string, unknown>;
      const rows = diffRows(
        AGENT_FIELDS,
        await agentValues(ctx, changes),
        await agentValues(ctx, before as unknown as Record<string, unknown>),
      );
      const warnings: string[] = [];
      if (changes.systemPrompt !== undefined && changes.systemPrompt !== before.systemPrompt) {
        warnings.push(`O prompt muda criando a versão ${(before.promptVersion ?? 0) + 1}.`);
      }
      if (changes.useForFlows === true && !before.useForFlows)
        warnings.push('Só um agente atende os fluxos automáticos: o atual deixa de ser.');
      return { title: 'Editar agente', summary: before.name, action: 'update', rows, warnings };
    },
    run: (ctx, i) => aiAdmin.updateAgent(ctx, i.agentId, i.changes),
  },
  archive_ai_agent: {
    preview: async (ctx, i) => {
      const agent = await agentById(ctx, i.agentId);
      if (agent.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar agente',
        summary: agent.name,
        action: 'delete',
        rows: [{ label: 'Ativo', before: yesNo(agent.isActive), after: 'Não' }],
        warnings: [
          'Com conversas, o agente é arquivado e desativado; sem nenhuma, é excluído.',
          ...(agent.useForFlows ? ['Ele atende os fluxos automáticos: os fluxos ficam sem agente.'] : []),
        ],
      };
    },
    run: (ctx, i) => aiAdmin.deleteAgent(ctx, i.agentId),
  },

  /* ---- kits de ferramentas ---- */
  list_agent_tools: {
    run: async (ctx, i) =>
      aiAdmin.listToolCatalog(ctx).filter((tool) => (!i.kind || tool.kind === i.kind) && (!i.category || tool.category === i.category)),
  },
  list_tool_kits: { run: (ctx) => aiAdmin.listToolKits(ctx) },
  create_tool_kit: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      return {
        title: 'Criar kit de ferramentas',
        summary: i.name,
        action: 'create',
        rows: [
          { label: 'Nome', after: i.name },
          ...(i.description ? [{ label: 'Descrição', after: i.description }] : []),
          ...kitRows(i.tools),
        ],
      };
    },
    run: (ctx, i) => aiAdmin.createToolKit(ctx, i),
  },
  update_tool_kit: {
    preview: async (ctx, i) => {
      const before = await aiAdmin.getToolKit(ctx, i.kitId);
      const rows = diffRows(
        [
          { key: 'name', label: 'Nome' },
          { key: 'description', label: 'Descrição' },
        ],
        i.changes,
        before as unknown as Record<string, unknown>,
      );
      if (i.changes.tools) {
        const old = new Map(before.tools.map((x) => [x.name, x.mode]));
        const next = new Map(i.changes.tools.map((x) => [x.name, x.mode]));
        kitRows(i.changes.tools);
        const added = [...next.keys()].filter((name) => !old.has(name));
        const removed = [...old.keys()].filter((name) => !next.has(name));
        const changed = [...next.entries()]
          .filter(([name, mode]) => old.has(name) && old.get(name) !== mode)
          .map(([name, mode]) => `${name} → ${mode}`);
        rows.push({ label: 'Ferramentas', before: String(old.size), after: String(next.size) });
        if (added.length) rows.push({ label: 'Entram', after: listed(added, 20) });
        if (removed.length) rows.push({ label: 'Saem', after: listed(removed, 20) });
        if (changed.length) rows.push({ label: 'Modo trocado', after: listed(changed, 20) });
      }
      return {
        title: 'Editar kit de ferramentas',
        summary: before.name,
        action: 'update',
        rows,
        warnings: before.agents.length ? [`Vale na próxima chamada de: ${before.agents.map((a) => a.name).join(', ')}.`] : [],
      };
    },
    run: (ctx, i) => aiAdmin.updateToolKit(ctx, i.kitId, i.changes),
  },
  duplicate_tool_kit: {
    preview: async (ctx, i) => {
      const source = await aiAdmin.getToolKit(ctx, i.kitId);
      return {
        title: 'Duplicar kit de ferramentas',
        summary: source.name,
        action: 'create',
        rows: [
          { label: 'Nome da cópia', after: i.name ?? t.agents.toolKits.copyName(source.name) },
          { label: 'Ferramentas', after: String(source.tools.length) },
        ],
      };
    },
    run: (ctx, i) => aiAdmin.duplicateToolKit(ctx, i.kitId, { name: i.name }),
  },
  delete_tool_kit: {
    preview: async (ctx, i) => {
      const kit = await aiAdmin.getToolKit(ctx, i.kitId);
      if (kit.agents.length > 0) throw unprocessable(t.agents.errors.toolKitInUse(kit.agents.map((a) => a.name)), 'tool_kit_in_use');
      return {
        title: 'Excluir kit de ferramentas',
        summary: kit.name,
        action: 'delete',
        rows: [{ label: 'Ferramentas', before: String(kit.tools.length), after: '—' }],
      };
    },
    run: (ctx, i) => aiAdmin.deleteToolKit(ctx, i.kitId),
  },

  /* ---- servidores MCP ---- */
  list_mcp_servers: { run: (ctx) => aiAdmin.listMcpServers(ctx) },
  create_mcp_server: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      return {
        title: 'Cadastrar servidor MCP',
        summary: i.name,
        action: 'create',
        rows: [
          ...diffRows(MCP_FIELDS, i),
          ...(i.secretHeaderNames.length ? [{ label: 'Cabeçalhos secretos', after: i.secretHeaderNames.join(', ') }] : []),
        ],
        ...(i.secretHeaderNames.length ? { secretFields: headerFields(i.secretHeaderNames, false) } : {}),
      };
    },
    run: (ctx, i, meta) => {
      const { secretHeaderNames, ...rest } = i;
      return aiAdmin.createMcpServer(ctx, mcpServerCreateInput.parse({ ...rest, headers: typedHeaders(secretHeaderNames, meta.secrets) }));
    },
  },
  update_mcp_server: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const before = await mcpById(ctx, i.serverId);
      const { setHeaderNames, removeHeaders, ...changes } = i.changes;
      const rows = diffRows(MCP_FIELDS, changes, before as unknown as Record<string, unknown>);
      if (setHeaderNames.length) rows.push({ label: 'Cabeçalhos a definir', after: setHeaderNames.join(', ') });
      if (removeHeaders.length) rows.push({ label: 'Cabeçalhos a remover', after: removeHeaders.join(', ') });
      return {
        title: 'Editar servidor MCP',
        summary: before.name,
        action: 'update',
        rows,
        ...(setHeaderNames.length ? { secretFields: headerFields(setHeaderNames, true) } : {}),
      };
    },
    run: (ctx, i, meta) => {
      const { setHeaderNames, removeHeaders, ...changes } = i.changes;
      return aiAdmin.updateMcpServer(
        ctx,
        i.serverId,
        mcpServerUpdateInput.parse({ ...changes, setHeaders: typedHeaders(setHeaderNames, meta.secrets), removeHeaders }),
      );
    },
  },
  archive_mcp_server: {
    preview: async (ctx, i) => {
      const server = await mcpById(ctx, i.serverId);
      if (server.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar servidor MCP',
        summary: server.name,
        action: 'delete',
        rows: [{ label: 'URL', after: server.url }],
        warnings: ['Ligado a agentes, o servidor é arquivado e desativado; sem vínculo, é excluído.'],
      };
    },
    run: (ctx, i) => aiAdmin.deleteMcpServer(ctx, i.serverId),
  },
  refresh_mcp_tools: {
    preview: async (ctx, i) => {
      const server = await mcpById(ctx, i.serverId);
      return {
        title: 'Atualizar tools do servidor MCP',
        summary: server.name,
        action: 'other',
        rows: [
          { label: 'URL', after: server.url },
          { label: 'Tools em cache', after: String(server.tools?.length ?? 0) },
        ],
      };
    },
    run: (ctx, i) => aiAdmin.refreshMcpServer(ctx, i.serverId),
  },

  /* ---- configurações, uso e requisições ---- */
  get_app_settings: { run: (ctx) => aiRequests.listSettings(ctx) },
  set_app_setting: {
    preview: async (ctx, i) => {
      const before = await aiRequests.getSetting(ctx, i.key);
      const show = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
      return {
        title: 'Alterar configuração do sistema',
        summary: i.key,
        action: 'update',
        rows: [
          {
            label: i.key,
            before: `${show(before.value)} (${before.source === 'database' ? 'banco' : before.envName})`,
            after: i.value === null ? `${show(before.envValue)} (padrão de ${before.envName})` : show(i.value),
          },
        ],
      };
    },
    run: (ctx, i) => (i.value === null ? aiRequests.deleteSetting(ctx, i.key) : aiRequests.putSetting(ctx, i.key, i.value)),
  },
  get_ai_usage: { run: (ctx, i) => aiAdmin.usageReport(ctx, { from: i.from, to: i.to }) },

  /* ---- orçamentos de IA (spec 028) ---- */
  list_ai_budgets: { run: (ctx) => aiBudgets.listBudgets(ctx) },
  create_ai_budget: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const username = i.userId ? await userName(ctx, i.userId) : null;
      const agentName = i.agentId ? await agentNameOf(ctx, i.agentId) : null;
      const label = budgetScopeLabel({ scope: i.scope, username, agentName });
      return {
        title: 'Criar orçamento de IA',
        summary: label,
        action: 'create',
        rows: [
          { label: 'Escopo', after: label },
          { label: 'Valor mensal', after: formatMicros(toMicros(i.monthlyLimit), i.currency) },
          { label: 'Aviso em', after: `${i.alertPercent}%` },
          { label: 'Ativo', after: yesNo(i.isActive) },
        ],
        warnings: [BUDGET_WARNING],
      };
    },
    run: (ctx, i) => aiBudgets.createBudget(ctx, i),
  },
  update_ai_budget: {
    preview: async (ctx, i) => {
      const budget = await aiBudgets.getBudget(ctx, i.budgetId);
      const currency = i.changes.currency ?? budget.currency;
      return {
        title: 'Editar orçamento de IA',
        summary: budgetScopeLabel(budget),
        action: 'update',
        rows: diffRows(
          [
            { key: 'limit', label: 'Valor mensal' },
            { key: 'currency', label: 'Moeda' },
            { key: 'alert', label: 'Aviso em' },
            { key: 'active', label: 'Ativo', format: 'bool' },
          ],
          {
            limit:
              i.changes.monthlyLimit !== undefined || i.changes.currency !== undefined
                ? formatMicros(
                    i.changes.monthlyLimit !== undefined ? toMicros(i.changes.monthlyLimit) : budget.monthlyLimitMicros,
                    currency,
                  )
                : undefined,
            currency: i.changes.currency,
            alert: i.changes.alertPercent !== undefined ? `${i.changes.alertPercent}%` : undefined,
            active: i.changes.isActive,
          },
          budgetPreviewValues(budget),
        ),
        warnings: i.changes.isActive === false ? [] : [BUDGET_WARNING],
      };
    },
    run: (ctx, i) => aiBudgets.updateBudget(ctx, i.budgetId, i.changes),
  },
  delete_ai_budget: {
    preview: async (ctx, i) => {
      const budget = await aiBudgets.getBudget(ctx, i.budgetId);
      return {
        title: 'Excluir orçamento de IA',
        summary: budgetScopeLabel(budget),
        action: 'delete',
        rows: [
          { label: 'Valor mensal', after: formatMicros(budget.monthlyLimitMicros, budget.currency) },
          {
            label: 'Gasto no mês',
            after: budget.current ? formatMicros(budget.current.spentMicros, budget.currency) : '—',
          },
        ],
        warnings: ['Para só suspender o orçamento, desative-o em vez de excluir.'],
      };
    },
    run: (ctx, i) => aiBudgets.deleteBudget(ctx, i.budgetId),
  },
  list_ai_requests: { run: (ctx, i) => aiRequests.listRequests(ctx, i) },

  /* ---- backup ---- */
  export_backup: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      if (i.what === 'dump') {
        const status = await backupStatus(ctx);
        if (!status.dumpAvailable) throw unprocessable(status.dumpUnavailableReason ?? t.errors.generic, 'dump_unavailable');
      }
      return {
        title: 'Exportar backup',
        summary: BACKUP_LABEL[i.what] ?? i.what,
        action: 'other',
        rows: [{ label: 'Arquivo', after: BACKUP_LABEL[i.what] ?? i.what }],
        warnings: [
          'O arquivo leva as chaves dos provedores, os tokens e as senhas (como o export da tela) e fica como anexo desta sessão; o conteúdo não vai ao modelo.',
          'Acima de 20 MB, o arquivo não cabe num anexo: use a tela Backup e restauração.',
        ],
      };
    },
    run: async (ctx, i) => {
      ctx.access.assertAdmin();
      const file = await exportFile(ctx, i.what);
      return { what: i.what, file };
    },
  },
  simulate_import: { run: async (ctx, i) => reportForModel(await importFrom(ctx, i.attachmentId, true)) },
  import_backup: {
    preview: async (ctx, i): Promise<ToolPreview> => {
      const report = await importFrom(ctx, i.attachmentId, true);
      return {
        title: 'Importar backup',
        summary: report.kind === 'full' ? 'Conteúdo completo' : (t.backup.resources[report.kind]?.title ?? report.kind),
        action: 'create',
        rows: importRows(report),
        warnings: [
          'Os registros já cadastrados ficam como estão; o que conflita não entra e volta com o motivo.',
          ...(report.issueCount > 0 ? [`${report.issueCount} item(ns) não entram (veja simulate_import).`] : []),
          ...(report.sourceSchemaVersion !== report.schemaVersion
            ? [`O arquivo é de outra versão do banco (${report.sourceSchemaVersion ?? '—'}; esta: ${report.schemaVersion ?? '—'}).`]
            : []),
        ],
      };
    },
    run: async (ctx, i) => reportForModel(await importFrom(ctx, i.attachmentId, false)),
  },
};
