import { randomInt } from 'node:crypto';
import { type Database, type Executor, userColumns, users } from '@moneyflow/db';
import {
  blocksText,
  chatMime,
  escapeTelegramHtml,
  formatDateTime,
  markdownToTelegramHtml,
  type TelegramAccountDto,
  type TelegramInboundConfigDto,
  type TelegramInboundDestinationDto,
  type TelegramLinkDto,
  type TelegramPairingCodeDto,
  type ToolConfirmationDto,
  t,
} from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { appendEvent, loadConfirmations, loadMessages, loadRun } from '../agents/store';
import { internalTool } from '../agents/tools-runtime';
import { type Access, type Actor, loadAccess } from '../authz/access';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { AppError, findPgError, notFound } from '../errors';
import {
  answerCallbackQuery,
  downloadFile,
  getFile,
  type InlineKeyboard,
  sendChatAction,
  sendChatMessage,
  TELEGRAM_DOWNLOAD_LIMIT,
} from '../integrations/telegram';
import { publicBaseUrl } from './ai-requests';
import { mediaCapabilities, uploadChatAttachment } from './chat-media';
import { activeSessionId, cancelRun, decideConfirmations, ensureActiveSession, finishSession, sendToAgent } from './conversations';
import { botOptions, inboundToken } from './messages';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Telegram de entrada (spec 029).
 *  - Webhook (sem sessão): o segredo do cabeçalho confere por
 *    telegram_webhook_authenticate; o update_id é marcado por
 *    telegram_update_seen (repetido = ignorado; se o processamento falhar, a
 *    marca sai e o Telegram reentrega).
 *  - Pareamento: Minha conta → Telegram gera um código de 8 caracteres (10
 *    min, uso único; só o hash no banco) e `/start <código>` no chat privado
 *    liga o chat ao usuário (telegram_pairing_consume). Só chats privados.
 *  - Conversa: a mensagem do chat pareado entra na sessão ativa do usuário com
 *    o agente do destino (o mesmo fio do console), como o próprio usuário. A
 *    execução nasce com o evento `telegram/origin`: o worker mantém o
 *    "digitando…", manda a resposta final (HTML do Telegram, partes de 4096) e
 *    os botões Aprovar/Recusar das tools em ask. Recusar pede o motivo na
 *    mensagem seguinte ("pular" = sem motivo). Quem decidir primeiro (chat ou
 *    console) vale.
 *  - Mídia: voz e áudio transcritos (spec 025), fotos e documentos como
 *    anexos, até 20 MB (limite da Bot API).
 * O token do bot só é lido por telegram_inbound_bot_token e nunca sai daqui.
 */

type TgUser = { id: number; is_bot?: boolean; username?: string; first_name?: string };
type TgChat = { id: number; type: string };
type TgFile = { file_id: string; file_size?: number; mime_type?: string; file_name?: string; duration?: number };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  voice?: TgFile;
  audio?: TgFile;
  photo?: TgFile[];
  document?: TgFile;
};
type TgCallback = { id: string; from: TgUser; message?: { message_id: number; chat: TgChat }; data?: string };
export type TelegramUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };

export type InboundDeps = { db: Database; config: Config; log: FastifyBaseLogger };

type DestinationRow = {
  id: string;
  name: string;
  owner_user_id: string | null;
  owner_caixa_id: string | null;
  inbound_agent_id: string | null;
  bot_id: string | null;
};

/* ---------------- configuração e conta ---------------- */

export async function inboundConfig(ctx: ServiceContext): Promise<TelegramInboundConfigDto> {
  const base = await publicBaseUrl(ctx.db, ctx.config);
  return { publicBaseUrl: base.url, source: base.source, available: base.available };
}

/** O usuário pode usar o destino: pessoal dele, de caixa que ele lê, ou global. */
function canUse(access: Access, d: Pick<DestinationRow, 'owner_user_id' | 'owner_caixa_id'>) {
  if (d.owner_user_id) return d.owner_user_id === access.actor.id;
  if (d.owner_caixa_id) return access.canRead(d.owner_caixa_id);
  return true;
}

const ownerKind = (d: Pick<DestinationRow, 'owner_user_id' | 'owner_caixa_id'>) =>
  d.owner_user_id ? 'user' : d.owner_caixa_id ? 'caixa' : 'global';

async function inboundDestinations(db: Executor): Promise<(DestinationRow & { agent_name: string | null })[]> {
  const result = await db.execute<DestinationRow & { agent_name: string | null }>(sql`
    SELECT d.id, d.name, d.owner_user_id, d.owner_caixa_id, d.inbound_agent_id, d.bot_id, a.name AS agent_name
      FROM message_destinations d LEFT JOIN ai_agents a ON a.id = d.inbound_agent_id
     WHERE d.inbound_enabled AND d.is_active AND d.archived_at IS NULL
     ORDER BY lower(d.name), d.id`);
  return result.rows;
}

type LinkRow = {
  id: string;
  destination_id: string;
  destination_name: string;
  user_id: string;
  username: string;
  chat_id: string;
  telegram_username: string | null;
  created_at: unknown;
  revoked_at: unknown;
};

const linkDto = (r: LinkRow): TelegramLinkDto => ({
  id: r.id,
  destinationId: r.destination_id,
  destinationName: r.destination_name,
  userId: r.user_id,
  username: r.username,
  chatId: String(r.chat_id),
  telegramUsername: r.telegram_username,
  createdAt: iso(r.created_at)!,
  revokedAt: iso(r.revoked_at),
});

const LINK_SELECT = sql`
  SELECT l.id, l.destination_id, d.name AS destination_name, l.user_id, u.username, l.chat_id::text AS chat_id,
         l.username AS telegram_username, l.created_at, l.revoked_at
    FROM telegram_links l JOIN message_destinations d ON d.id = l.destination_id JOIN users u ON u.id = l.user_id`;

/** Minha conta → Telegram: os destinos com entrada que eu posso usar e os meus pareamentos (o admin: todos, com `all`). */
export async function accountTelegram(ctx: ServiceContext, all = false): Promise<TelegramAccountDto> {
  if (all) ctx.access.assertAdmin();
  const destinations: TelegramInboundDestinationDto[] = (await inboundDestinations(ctx.db))
    .filter((d) => canUse(ctx.access, d))
    .map((d) => ({
      id: d.id,
      name: d.name,
      botId: d.bot_id,
      ownerKind: ownerKind(d),
      agentId: d.inbound_agent_id,
      agentName: d.agent_name,
    }));
  const links = await ctx.db.execute<LinkRow>(sql`
    ${LINK_SELECT}
     WHERE ${all ? sql`true` : sql`l.user_id = ${ctx.access.actor.id}`}
     ORDER BY l.revoked_at NULLS FIRST, l.created_at DESC
     LIMIT 500`);
  return { destinations, links: links.rows.map(linkDto) };
}

/** Código sem caracteres ambíguos (0/O, 1/I/L), 8 letras ou dígitos. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export async function createPairingCode(ctx: ServiceContext, destinationId: string): Promise<TelegramPairingCodeDto> {
  const destination = (await inboundDestinations(ctx.db)).find((d) => d.id === destinationId);
  if (!destination || !canUse(ctx.access, destination)) throw notFound();
  for (let attempt = 0; ; attempt += 1) {
    const code = newCode();
    try {
      const row = await withTx(ctx, async (tx) => {
        const result = await tx.execute<{ id: string; expires_at: unknown }>(
          sql`SELECT id, expires_at FROM telegram_pairing_code_create(${ctx.access.actor.id}::uuid, ${destinationId}::uuid, ${code})`,
        );
        return result.rows[0]!;
      });
      return {
        code,
        expiresAt: iso(row.expires_at)!,
        destinationId,
        destinationName: destination.name,
        botId: destination.bot_id,
      };
    } catch (error) {
      if (attempt < 3 && findPgError(error)?.constraint === 'telegram_pairing_codes_code_hash_key') continue;
      throw error;
    }
  }
}

/** Desfaz um pareamento (o meu; o admin, qualquer um). Irreversível. */
export async function revokeLink(ctx: ServiceContext, linkId: string) {
  const result = await ctx.db.execute<{ user_id: string; revoked_at: unknown }>(
    sql`SELECT user_id, revoked_at FROM telegram_links WHERE id = ${linkId}`,
  );
  const row = result.rows[0];
  if (!row || (row.user_id !== ctx.access.actor.id && !ctx.access.isAdmin)) throw notFound();
  if (!row.revoked_at) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE telegram_links SET revoked_at = now() WHERE id = ${linkId} AND revoked_at IS NULL`));
  }
  const links = await ctx.db.execute<LinkRow>(sql`${LINK_SELECT} WHERE l.id = ${linkId}`);
  return linkDto(links.rows[0]!);
}

/* ---------------- webhook ---------------- */

/** Confere o cabeçalho X-Telegram-Bot-Api-Secret-Token (false = 401). */
export async function authenticateWebhook(db: Executor, destinationId: string, secret: string | null): Promise<boolean> {
  if (!secret) return false;
  const result = await db.execute<{ ok: boolean }>(sql`SELECT telegram_webhook_authenticate(${destinationId}::uuid, ${secret}) AS ok`);
  return Boolean(result.rows[0]?.ok);
}

/**
 * Processa uma atualização do webhook. Repetida (mesmo update_id) é ignorada;
 * se o processamento falhar, a marca é desfeita para o Telegram reentregar.
 */
export async function handleUpdate(deps: InboundDeps, destinationId: string, update: TelegramUpdate): Promise<'ok' | 'duplicate'> {
  const { db } = deps;
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return 'ok';
  const seen = await db.execute<{ seen: boolean }>(
    sql`SELECT telegram_update_seen(${destinationId}::uuid, ${update.update_id}::bigint) AS seen`,
  );
  if (seen.rows[0]?.seen) return 'duplicate';
  try {
    await processUpdate(deps, destinationId, update);
    return 'ok';
  } catch (error) {
    await db
      .execute(sql`DELETE FROM telegram_updates_seen WHERE destination_id = ${destinationId} AND update_id = ${update.update_id}`)
      .catch(() => {});
    throw error;
  }
}

type Bot = {
  token: string;
  say: (chatId: number | string, html: string, keyboard?: InlineKeyboard) => Promise<void>;
};

function bot(deps: InboundDeps, token: string): Bot {
  return {
    token,
    say: async (chatId, html, keyboard) => {
      const result = await sendChatMessage(botOptions(deps.config), token, chatId, html, keyboard);
      if (!result.ok) deps.log.warn({ error: result.error }, 'telegram: resposta não enviada');
    },
  };
}

async function loadDestination(db: Executor, destinationId: string): Promise<DestinationRow | null> {
  const result = await db.execute<DestinationRow>(sql`
    SELECT id, name, owner_user_id, owner_caixa_id, inbound_agent_id, bot_id FROM message_destinations
     WHERE id = ${destinationId} AND inbound_enabled AND is_active AND archived_at IS NULL`);
  return result.rows[0] ?? null;
}

/** Contexto do usuário pareado (como ele mesmo); null se inativo ou sem acesso ao destino. */
async function userContext(deps: InboundDeps, userId: string, destination: DestinationRow): Promise<ServiceContext | null> {
  const [user] = await deps.db.select(userColumns).from(users).where(eq(users.id, userId));
  if (!user?.isActive) return null;
  const actor: Actor = { id: user.id, username: user.username, email: user.email, role: user.role as Actor['role'], isActive: true };
  const access = await loadAccess(deps.db, actor);
  if (!canUse(access, destination)) return null;
  return { db: deps.db, config: deps.config, access };
}

async function linkedUser(db: Executor, destinationId: string, chatId: number): Promise<string | null> {
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT user_id FROM telegram_links WHERE destination_id = ${destinationId} AND chat_id = ${chatId} AND revoked_at IS NULL`);
  return result.rows[0]?.user_id ?? null;
}

const command = (text: string) => /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());

async function processUpdate(deps: InboundDeps, destinationId: string, update: TelegramUpdate) {
  const destination = await loadDestination(deps.db, destinationId);
  if (!destination?.inbound_agent_id) return;
  const token = await inboundToken(deps.db, destinationId);
  if (!token) return;
  const b = bot(deps, token);
  if (update.callback_query) return handleCallback(deps, destination, b, update.callback_query);
  const message = update.message;
  if (!message?.chat || message.from?.is_bot) return;
  if (message.chat.type !== 'private') return;
  const chatId = message.chat.id;
  const text = (message.text ?? message.caption ?? '').trim();
  const cmd = command(text);

  if (cmd && cmd[1]!.toLowerCase() === 'start') {
    const code = cmd[2]?.trim();
    if (code) {
      const consumed = await deps.db.transaction(async (tx) => {
        const result = await tx.execute<{ link_id: string; user_id: string }>(sql`
          SELECT link_id, user_id FROM telegram_pairing_consume(${destinationId}::uuid, ${code}, ${chatId}::bigint,
                                                                  ${message.from?.id ?? chatId}::bigint, ${message.from?.username ?? null})`);
        return result.rows[0] ?? null;
      });
      if (!consumed) return b.say(chatId, escapeTelegramHtml(t.agents.telegram.pairingInvalid));
      const agent = await deps.db.execute<{ name: string }>(sql`SELECT name FROM ai_agents WHERE id = ${destination.inbound_agent_id}`);
      const user = await deps.db.execute<{ username: string }>(sql`SELECT username FROM users WHERE id = ${consumed.user_id}`);
      return b.say(chatId, escapeTelegramHtml(t.agents.telegram.paired(user.rows[0]?.username ?? '', agent.rows[0]?.name ?? '')));
    }
  }

  const userId = await linkedUser(deps.db, destinationId, chatId);
  if (!userId) return b.say(chatId, escapeTelegramHtml(t.agents.telegram.notPaired));
  const ctx = await userContext(deps, userId, destination);
  if (!ctx) return b.say(chatId, escapeTelegramHtml(t.agents.telegram.unavailable));
  const agentId = destination.inbound_agent_id;

  if (cmd) {
    const name = cmd[1]!.toLowerCase();
    if (name === 'start' || name === 'ajuda' || name === 'help') return b.say(chatId, t.agents.telegram.help);
    if (name === 'nova') return commandNew(ctx, b, chatId, agentId);
    if (name === 'parar') return commandStop(ctx, b, chatId, agentId);
    if (name === 'agente') return commandAgent(ctx, b, chatId, agentId);
  }

  // Motivo de uma recusa pedida pelo botão "Recusar".
  if (text && (await reasonForRejection(ctx, b, chatId, agentId, text))) return;

  // Execução anterior ainda ativa: não manda ao agente.
  const sessionId = await activeSessionId(ctx.db, userId, agentId);
  if (sessionId) {
    const active = await ctx.db.execute<{ status: string }>(sql`
      SELECT status FROM ai_runs WHERE conversation_id = ${sessionId} AND status IN ('queued', 'running', 'awaiting_confirmation')`);
    const status = active.rows[0]?.status;
    if (status)
      return b.say(
        chatId,
        escapeTelegramHtml(status === 'awaiting_confirmation' ? t.agents.telegram.busyAwaiting : t.agents.telegram.busy),
      );
  }

  const files = mediaOf(message);
  if (!text && files.length === 0) return b.say(chatId, escapeTelegramHtml(t.agents.telegram.unsupported));
  void sendChatAction(botOptions(deps.config), token, chatId).catch(() => null);

  const attachmentIds: string[] = [];
  if (files.length > 0) {
    const session = await ensureActiveSession(ctx, agentId);
    const media = await mediaCapabilities(ctx.db, agentId);
    for (const file of files) {
      if (file.audio && !media.transcription) {
        await b.say(chatId, escapeTelegramHtml(t.agents.telegram.noTranscription));
        continue;
      }
      const id = await downloadToChat(deps, ctx, b, chatId, session.id, file);
      if (id) attachmentIds.push(id);
    }
  }
  if (!text && attachmentIds.length === 0) return;
  try {
    await sendToAgent(
      ctx,
      agentId,
      { text, attachmentIds },
      { origin: { type: 'telegram', action: 'origin', destinationId, chatId: String(chatId) } },
    );
  } catch (error) {
    if (error instanceof AppError) {
      const busy = error.code === 'run_active';
      return b.say(chatId, escapeTelegramHtml(busy ? t.agents.telegram.busy : error.message));
    }
    throw error;
  }
}

type MediaFile = TgFile & { name: string; mime: string; audio: boolean; durationMs: number | null };

function mediaOf(message: TgMessage): MediaFile[] {
  const out: MediaFile[] = [];
  const id = message.message_id;
  if (message.voice) {
    out.push({
      ...message.voice,
      name: `voz-${id}.ogg`,
      mime: message.voice.mime_type ?? 'audio/ogg',
      audio: true,
      durationMs: message.voice.duration ? message.voice.duration * 1000 : null,
    });
  }
  if (message.audio) {
    const name = message.audio.file_name ?? `audio-${id}.mp3`;
    out.push({
      ...message.audio,
      name,
      mime: chatMime(name, message.audio.mime_type),
      audio: true,
      durationMs: message.audio.duration ? message.audio.duration * 1000 : null,
    });
  }
  if (message.photo?.length) {
    const largest = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
    out.push({ ...largest, name: `foto-${id}.jpg`, mime: 'image/jpeg', audio: false, durationMs: null });
  }
  if (message.document) {
    const name = message.document.file_name ?? `documento-${id}`;
    const mime = chatMime(name, message.document.mime_type);
    out.push({ ...message.document, name, mime, audio: mime.startsWith('audio/'), durationMs: null });
  }
  return out;
}

/** Baixa o arquivo do Telegram e o anexa à sessão (a transcrição do áudio é enfileirada no upload, spec 025). */
async function downloadToChat(
  deps: InboundDeps,
  ctx: ServiceContext,
  b: Bot,
  chatId: number,
  sessionId: string,
  file: MediaFile,
): Promise<string | null> {
  if ((file.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) {
    await b.say(chatId, escapeTelegramHtml(t.agents.telegram.fileTooLarge));
    return null;
  }
  const opts = botOptions(deps.config);
  const meta = await getFile(opts, b.token, file.file_id);
  if (!meta.ok || !meta.result.file_path) {
    const reason = meta.ok ? 'file_path' : meta.error;
    await b.say(
      chatId,
      escapeTelegramHtml(/too big/i.test(reason) ? t.agents.telegram.fileTooLarge : t.agents.telegram.unreadable(reason)),
    );
    return null;
  }
  const data = await downloadFile(opts, b.token, meta.result.file_path);
  if (!data.ok) {
    await b.say(
      chatId,
      escapeTelegramHtml(data.error === 'file too large' ? t.agents.telegram.fileTooLarge : t.agents.telegram.unreadable(data.error)),
    );
    return null;
  }
  try {
    const attachment = await uploadChatAttachment(ctx, sessionId, {
      name: file.name,
      mime: file.mime,
      content: data.data,
      durationMs: file.durationMs ?? undefined,
    });
    return attachment.id;
  } catch (error) {
    if (error instanceof AppError) {
      await b.say(chatId, escapeTelegramHtml(t.agents.telegram.unreadable(error.message)));
      return null;
    }
    throw error;
  }
}

/* ---------------- comandos ---------------- */

async function commandNew(ctx: ServiceContext, b: Bot, chatId: number, agentId: string) {
  const sessionId = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
  if (sessionId) await finishSession(ctx, sessionId);
  await b.say(chatId, escapeTelegramHtml(t.agents.telegram.finished));
}

async function commandStop(ctx: ServiceContext, b: Bot, chatId: number, agentId: string) {
  const sessionId = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
  const run = sessionId
    ? await ctx.db.execute<{ id: string }>(sql`
        SELECT id FROM ai_runs WHERE conversation_id = ${sessionId} AND status IN ('queued', 'running', 'awaiting_confirmation')`)
    : null;
  const runId = run?.rows[0]?.id;
  if (!runId) return b.say(chatId, escapeTelegramHtml(t.agents.telegram.nothingToStop));
  await cancelRun(ctx, runId);
  await b.say(chatId, escapeTelegramHtml(t.agents.telegram.stopped));
}

async function commandAgent(ctx: ServiceContext, b: Bot, chatId: number, agentId: string) {
  const agent = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM ai_agents WHERE id = ${agentId}`);
  const sessionId = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
  let session: string | null = null;
  let count = 0;
  if (sessionId) {
    const row = await ctx.db.execute<{ title: string | null; created_at: unknown; n: number }>(sql`
      SELECT c.title, c.created_at, (SELECT count(*)::int FROM ai_messages m WHERE m.conversation_id = c.id) AS n
        FROM ai_conversations c WHERE c.id = ${sessionId}`);
    const r = row.rows[0];
    session = `${r?.title ?? t.agents.telegram.newSession} · ${formatDateTime(iso(r?.created_at) ?? '')}`;
    count = Number(r?.n ?? 0);
  }
  await b.say(
    chatId,
    t.agents.telegram.agentInfo(escapeTelegramHtml(agent.rows[0]?.name ?? ''), session ? escapeTelegramHtml(session) : null, count),
  );
}

/* ---------------- aprovações ---------------- */

type TelegramEvent = { action: string; confirmationId?: string; chatId?: string };

async function telegramEvents(db: Executor, runId: string): Promise<TelegramEvent[]> {
  const result = await db.execute<{ payload: TelegramEvent }>(sql`
    SELECT payload FROM ai_run_events WHERE run_id = ${runId} AND event_type = 'telegram' ORDER BY seq`);
  return result.rows.map((r) => r.payload);
}

/** A mensagem é o motivo de uma recusa pedida pelo botão (a última sem resposta neste chat)? Decide e responde. */
async function reasonForRejection(ctx: ServiceContext, b: Bot, chatId: number, agentId: string, text: string): Promise<boolean> {
  const sessionId = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
  if (!sessionId) return false;
  const run = await ctx.db.execute<{ id: string }>(sql`
    SELECT id FROM ai_runs WHERE conversation_id = ${sessionId} AND status = 'awaiting_confirmation'`);
  const runId = run.rows[0]?.id;
  if (!runId) return false;
  const events = await telegramEvents(ctx.db, runId);
  let pending: string | null = null;
  for (const event of events) {
    if (event.chatId !== String(chatId)) continue;
    if (event.action === 'reason_requested') pending = event.confirmationId ?? null;
    if (event.action === 'reason_done' && event.confirmationId === pending) pending = null;
  }
  if (!pending) return false;
  const confirmation = (await loadConfirmations(ctx.db, runId, true)).find((c) => c.id === pending);
  await appendEvent(ctx.db, runId, { type: 'telegram', action: 'reason_done', confirmationId: pending, chatId: String(chatId) });
  if (!confirmation) return false;
  const reason = text.toLowerCase() === t.agents.telegram.skipReason ? undefined : text.slice(0, 2000);
  const decided = await decideSafely(ctx, runId, confirmation.id, 'rejected', reason);
  await b.say(
    chatId,
    escapeTelegramHtml(
      decided ? t.agents.telegram.rejected(confirmation.preview?.title ?? confirmation.toolName) : t.agents.telegram.alreadyDecided,
    ),
  );
  return true;
}

async function decideSafely(ctx: ServiceContext, runId: string, id: string, decision: 'approved' | 'rejected', reason?: string) {
  try {
    const result = await decideConfirmations(ctx, runId, { decision, ids: [id], ...(reason ? { reason } : {}) });
    return result.decided > 0;
  } catch (error) {
    if (error instanceof AppError || findPgError(error)) return false;
    throw error;
  }
}

async function handleCallback(deps: InboundDeps, destination: DestinationRow, b: Bot, callback: TgCallback) {
  const opts = botOptions(deps.config);
  const answer = (text?: string) => answerCallbackQuery(opts, b.token, callback.id, text).catch(() => null);
  const chatId = callback.message?.chat.id ?? callback.from.id;
  const match = /^(ok|no):([0-9a-f-]{36})$/i.exec(callback.data ?? '');
  if (!match || callback.message?.chat.type !== 'private') return void (await answer());
  const userId = await linkedUser(deps.db, destination.id, chatId);
  const ctx = userId ? await userContext(deps, userId, destination) : null;
  if (!ctx) {
    await answer(t.agents.telegram.notPaired.slice(0, 200));
    return;
  }
  const found = await deps.db.execute<{ run_id: string; tool_name: string; status: string; user_id: string; title: string | null }>(sql`
    SELECT c.run_id, c.tool_name, c.status, r.user_id, c.preview ->> 'title' AS title
      FROM ai_tool_confirmations c JOIN ai_runs r ON r.id = c.run_id WHERE c.id = ${match[2]}`);
  const confirmation = found.rows[0];
  if (!confirmation || confirmation.user_id !== ctx.access.actor.id || confirmation.status !== 'pending') {
    await answer(t.agents.telegram.alreadyDecided);
    return;
  }
  const title = confirmation.title ?? confirmation.tool_name;
  if (match[1]!.toLowerCase() === 'ok') {
    if (internalTool(confirmation.tool_name)?.secrets?.length) {
      await answer(t.agents.telegram.secretApproval.slice(0, 200));
      return b.say(chatId, escapeTelegramHtml(t.agents.telegram.secretApproval));
    }
    const decided = await decideSafely(ctx, confirmation.run_id, match[2]!, 'approved');
    await answer(decided ? t.agents.telegram.approved(title) : t.agents.telegram.alreadyDecided);
    if (decided) await b.say(chatId, escapeTelegramHtml(t.agents.telegram.approved(title)));
    return;
  }
  await appendEvent(deps.db, confirmation.run_id, {
    type: 'telegram',
    action: 'reason_requested',
    confirmationId: match[2]!,
    chatId: String(chatId),
  });
  await answer();
  await b.say(chatId, escapeTelegramHtml(t.agents.telegram.askReason));
}

/* ---------------- worker: digitando, resposta e botões ---------------- */

export type TelegramOrigin = { destinationId: string; chatId: string };

/** A execução veio de um chat do Telegram (evento telegram/origin gravado com ela)? */
export async function telegramOrigin(db: Executor, runId: string): Promise<TelegramOrigin | null> {
  const result = await db.execute<{ payload: { destinationId?: string; chatId?: string } }>(sql`
    SELECT payload FROM ai_run_events
     WHERE run_id = ${runId} AND event_type = 'telegram' AND payload ->> 'action' = 'origin'
     ORDER BY seq LIMIT 1`);
  const payload = result.rows[0]?.payload;
  return payload?.destinationId && payload.chatId ? { destinationId: payload.destinationId, chatId: payload.chatId } : null;
}

/** "digitando…" a cada 4 s enquanto a execução roda; devolve a função que para. */
export async function startTyping(db: Executor, config: Config, origin: TelegramOrigin): Promise<() => void> {
  const token = await inboundToken(db, origin.destinationId);
  if (!token) return () => {};
  const opts = botOptions(config);
  const tick = () => void sendChatAction(opts, token, origin.chatId).catch(() => null);
  tick();
  const timer = setInterval(tick, 4_000);
  return () => clearInterval(timer);
}

/** Prévia resumida de uma confirmação para o chat (título, resumo, linhas e avisos). */
export function confirmationHtml(c: ToolConfirmationDto, secret: boolean): string {
  const preview = c.preview;
  const lines = [t.agents.telegram.approvalTitle(escapeTelegramHtml(preview?.title ?? c.toolName))];
  if (preview?.summary) lines.push(escapeTelegramHtml(preview.summary));
  for (const row of (preview?.rows ?? []).slice(0, 12)) {
    const value = row.before !== undefined && row.before !== null ? `${row.before} → ${row.after ?? ''}` : String(row.after ?? '');
    lines.push(`• ${escapeTelegramHtml(row.label)}: ${escapeTelegramHtml(value.slice(0, 300))}`);
  }
  for (const warning of preview?.warnings ?? []) lines.push(`⚠ ${escapeTelegramHtml(warning)}`);
  if (secret) lines.push('', escapeTelegramHtml(t.agents.telegram.secretApproval));
  return lines.join('\n').slice(0, 4000);
}

/**
 * Depois de cada passada do worker numa execução vinda do Telegram: os
 * botões das confirmações novas (esperando aprovação) ou a resposta final.
 * O que já foi enviado fica marcado em eventos `telegram/sent` (não repete).
 */
export async function deliverRunToTelegram(deps: InboundDeps, runId: string) {
  const { db } = deps;
  const origin = await telegramOrigin(db, runId);
  if (!origin) return;
  const run = await loadRun(db, runId);
  if (!run) return;
  const token = await inboundToken(db, origin.destinationId);
  if (!token) return;
  const b = bot(deps, token);
  const sent = new Set((await telegramEvents(db, runId)).filter((e) => e.action === 'sent').map((e) => (e as { key?: string }).key));
  const mark = (key: string) => appendEvent(db, runId, { type: 'telegram', action: 'sent', key, chatId: origin.chatId });

  if (run.status === 'awaiting_confirmation') {
    for (const c of await loadConfirmations(db, runId, true)) {
      const key = `confirm:${c.id}`;
      if (sent.has(key)) continue;
      const secret = Boolean(internalTool(c.toolName)?.secrets?.length);
      const keyboard: InlineKeyboard = {
        inline_keyboard: [
          [
            ...(secret ? [] : [{ text: t.agents.telegram.approve, callback_data: `ok:${c.id}` }]),
            { text: t.agents.telegram.reject, callback_data: `no:${c.id}` },
          ],
        ],
      };
      await mark(key);
      await b.say(origin.chatId, confirmationHtml(c, secret), keyboard);
    }
    return;
  }
  if (!['completed', 'failed', 'canceled'].includes(run.status) || sent.has('final')) return;
  await mark('final');
  if (run.status === 'failed') return b.say(origin.chatId, escapeTelegramHtml(t.agents.telegram.failed(run.error ?? t.errors.generic)));
  if (run.status === 'canceled') return b.say(origin.chatId, escapeTelegramHtml(t.agents.telegram.canceled));
  const messages = await loadMessages(db, run.conversation_id);
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.run_id === runId && blocksText(m.content).trim());
  const chunks = markdownToTelegramHtml(last ? blocksText(last.content) : t.agents.telegram.emptyAnswer);
  for (const chunk of chunks) await b.say(origin.chatId, chunk);
}
