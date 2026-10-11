import type { MessagePayload } from '@moneyflow/shared';

/*
 * Cliente mínimo da Bot API do Telegram (só sendMessage). A URL base vem de
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
