import type { MessagePayload } from '@moneyflow/shared';

/*
 * Cliente mínimo da Bot API do Telegram: sendMessage (outbox, spec 013) e, na
 * entrada (spec 029), setWebhook, deleteWebhook, sendChatAction,
 * answerCallbackQuery, getFile e o download do arquivo. A URL base vem de
 * TELEGRAM_API_BASE (testes apontam para um mock). O token vai só no caminho
 * da URL e nunca aparece nas mensagens de erro devolvidas.
 */

export type TelegramResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      error: string;
      /** Segundos pedidos pelo Telegram num 429 (parameters.retry_after). */
      retryAfterSec: number | null;
      /** Erro que não muda com retry (400 chat não existe, 401 token inválido, 403 bot bloqueado, 404). */
      permanent: boolean;
    };

type BotApiResponse = {
  ok?: boolean;
  result?: { message_id?: number | string };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

/** Remove o token (e só a parte secreta, se vier quebrado) de qualquer texto. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  const secret = token.split(':')[1] ?? token;
  return text.split(token).join('<token>').split(secret).join('<token>');
}

export async function sendTelegramMessage(
  opts: { apiBase: string; timeoutMs: number },
  token: string,
  chatId: string,
  payload: MessagePayload,
): Promise<TelegramResult> {
  const url = `${opts.apiBase}/bot${token}/sendMessage`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: payload.text,
        parse_mode: payload.parse_mode,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, error: redactToken(`network: ${reason}`, token), retryAfterSec: null, permanent: false };
  }
  const body = (await response.json().catch(() => null)) as BotApiResponse | null;
  if (response.ok && body?.ok) {
    return { ok: true, messageId: String(body.result?.message_id ?? '') };
  }
  const status = body?.error_code ?? response.status;
  const description = redactToken(`${status} ${body?.description ?? response.statusText ?? 'error'}`.trim(), token);
  if (status === 429) {
    const retry = Number(body?.parameters?.retry_after ?? response.headers.get('retry-after') ?? 0);
    return { ok: false, error: description, retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : 30, permanent: false };
  }
  return { ok: false, error: description, retryAfterSec: null, permanent: [400, 401, 403, 404].includes(status) };
}

export type BotApiOptions = { apiBase: string; timeoutMs: number };

export type BotCallResult<T> = { ok: true; result: T } | { ok: false; error: string; status: number; retryAfterSec: number | null };

/** Chamada genérica da Bot API (JSON); o token nunca vai no erro. */
export async function botApiCall<T = unknown>(
  opts: BotApiOptions,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<BotCallResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${opts.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, error: redactToken(`network: ${reason}`, token), status: 0, retryAfterSec: null };
  }
  const json = (await response.json().catch(() => null)) as (BotApiResponse & { result?: T }) | null;
  if (response.ok && json?.ok) return { ok: true, result: json.result as T };
  const status = json?.error_code ?? response.status;
  const retry = Number(json?.parameters?.retry_after ?? 0);
  return {
    ok: false,
    error: redactToken(`${status} ${json?.description ?? response.statusText ?? 'error'}`.trim(), token),
    status,
    retryAfterSec: status === 429 && Number.isFinite(retry) && retry > 0 ? retry : null,
  };
}

/** Teclado inline (botões Aprovar/Recusar). */
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

/**
 * Mensagem a um chat (resposta do agente, comandos, aprovação): HTML do
 * Telegram, sem prévia de links, com teclado opcional. Um 429 espera o
 * retry_after (até 30 s) e tenta de novo uma vez; HTML recusado (400 "can't
 * parse entities") vai de novo como texto puro.
 */
export async function sendChatMessage(
  opts: BotApiOptions,
  token: string,
  chatId: string | number,
  html: string,
  replyMarkup?: InlineKeyboard,
): Promise<BotCallResult<{ message_id: number }>> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  let result = await botApiCall<{ message_id: number }>(opts, token, 'sendMessage', body);
  if (!result.ok && result.retryAfterSec !== null && result.retryAfterSec <= 30) {
    const wait = result.retryAfterSec * 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    result = await botApiCall(opts, token, 'sendMessage', body);
  }
  if (!result.ok && result.status === 400 && /parse entities/i.test(result.error)) {
    const plain = html
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    const { parse_mode: _mode, ...rest } = body;
    result = await botApiCall(opts, token, 'sendMessage', { ...rest, text: plain });
  }
  return result;
}

/** Liga o webhook: só mensagens e cliques nos botões, com o segredo no cabeçalho de cada entrega. */
export function setWebhook(opts: BotApiOptions, token: string, url: string, secretToken: string) {
  return botApiCall<boolean>(opts, token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

export function deleteWebhook(opts: BotApiOptions, token: string) {
  return botApiCall<boolean>(opts, token, 'deleteWebhook', { drop_pending_updates: true });
}

/** "digitando…" (dura ~5 s no Telegram; repita enquanto a execução roda). */
export function sendChatAction(opts: BotApiOptions, token: string, chatId: string | number, action = 'typing') {
  return botApiCall<boolean>(opts, token, 'sendChatAction', { chat_id: chatId, action });
}

export function answerCallbackQuery(opts: BotApiOptions, token: string, callbackQueryId: string, text?: string) {
  return botApiCall<boolean>(opts, token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 200) } : {}),
  });
}

export type TelegramFile = { file_id: string; file_unique_id?: string; file_size?: number; file_path?: string };

export function getFile(opts: BotApiOptions, token: string, fileId: string) {
  return botApiCall<TelegramFile>(opts, token, 'getFile', { file_id: fileId });
}

/** Limite de download de arquivo da Bot API (getFile). */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Baixa o arquivo de getFile (até 20 MB); o token fica fora do erro. */
export async function downloadFile(
  opts: BotApiOptions,
  token: string,
  filePath: string,
): Promise<{ ok: true; data: Buffer; mime: string | null } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${opts.apiBase}/file/bot${token}/${filePath}`, {
      signal: AbortSignal.timeout(Math.max(opts.timeoutMs, 60_000)),
    });
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > TELEGRAM_DOWNLOAD_LIMIT) return { ok: false, error: 'file too large' };
    return { ok: true, data, mime: response.headers.get('content-type') };
  } catch (error) {
    return { ok: false, error: redactToken(error instanceof Error ? error.message : String(error), token) };
  }
}
