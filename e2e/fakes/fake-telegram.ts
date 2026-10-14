import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Bot API do Telegram FALSA para testes (integração da API e e2e): nada vai
 * ao Telegram de verdade. Fala o suficiente da Bot API (POST
 * /bot<token>/<método> com JSON) para o MoneyFlow:
 *  - sendMessage (devolve message_id), sendChatAction, answerCallbackQuery;
 *  - setWebhook / deleteWebhook (guarda a URL e o secret_token por token, para
 *    o teste chamar o webhook simulando o Telegram), com `failNext` para recusar;
 *  - getFile e o download em GET /file/bot<token>/<file_path> dos arquivos
 *    registrados com `addFile` (voz, foto, documento).
 * Todas as chamadas ficam em `calls` (método, token e corpo). `update*`
 * monta as atualizações que o Telegram mandaria ao webhook.
 */

export type FakeTelegramCall = { method: string; token: string; body: Record<string, any> };
export type FakeWebhook = { url: string; secret: string; allowedUpdates: string[] };

export type FakeTelegram = {
  url: string;
  port: number;
  calls: FakeTelegramCall[];
  /** Webhook ligado por token do bot (setWebhook); some no deleteWebhook. */
  webhooks: Map<string, FakeWebhook>;
  /** Próximas chamadas de um método que falham (ex.: { setWebhook: 1 }). */
  failNext: Record<string, number>;
  /** Registra um arquivo para getFile/download; devolve o file_id. */
  addFile: (data: Buffer, mime: string, ext?: string) => string;
  /** Mensagens enviadas a um chat (sendMessage). */
  messagesTo: (chatId: number | string) => FakeTelegramCall[];
  close: () => Promise<void>;
};

let updateSeq = Math.floor(Date.now() / 1000) * 1000;
let messageSeq = 1;
const nextUpdate = () => {
  updateSeq += 1;
  return updateSeq;
};
const nextMessage = () => {
  messageSeq += 1;
  return messageSeq;
};

const user = (chatId: number, username?: string) => ({ id: chatId, is_bot: false, first_name: 'Teste', ...(username ? { username } : {}) });

/** Mensagem de texto num chat privado. */
export function textUpdate(chatId: number, text: string, opts: { username?: string; updateId?: number } = {}) {
  return {
    update_id: opts.updateId ?? nextUpdate(),
    message: {
      message_id: nextMessage(),
      from: user(chatId, opts.username),
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

/** Mensagem num grupo (o MoneyFlow só conversa em chat privado). */
export function groupUpdate(chatId: number, fromId: number, text: string) {
  return {
    update_id: nextUpdate(),
    message: {
      message_id: nextMessage(),
      from: user(fromId),
      chat: { id: chatId, type: 'group' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

/** Nota de voz (file_id de `addFile`). */
export function voiceUpdate(chatId: number, fileId: string, size: number, durationSec = 3) {
  return {
    update_id: nextUpdate(),
    message: {
      message_id: nextMessage(),
      from: user(chatId),
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      voice: { file_id: fileId, file_unique_id: `u${fileId}`, duration: durationSec, mime_type: 'audio/ogg', file_size: size },
    },
  };
}

/** Foto (o Telegram manda vários tamanhos; o maior é o último). */
export function photoUpdate(chatId: number, fileId: string, size: number, caption?: string) {
  return {
    update_id: nextUpdate(),
    message: {
      message_id: nextMessage(),
      from: user(chatId),
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      photo: [{ file_id: fileId, file_unique_id: `u${fileId}`, width: 1, height: 1, file_size: size }],
      ...(caption ? { caption } : {}),
    },
  };
}

/** Clique num botão inline (Aprovar/Recusar). */
export function callbackUpdate(chatId: number, data: string) {
  return {
    update_id: nextUpdate(),
    callback_query: {
      id: `cb${nextMessage()}`,
      from: user(chatId),
      message: { message_id: messageSeq, chat: { id: chatId, type: 'private' } },
      chat_instance: 'x',
      data,
    },
  };
}

/** O callback_data de um botão das mensagens enviadas ao chat (ex.: "Aprovar"). */
export function buttonData(call: FakeTelegramCall | undefined, label: string): string | null {
  const rows = (call?.body.reply_markup?.inline_keyboard ?? []) as { text: string; callback_data: string }[][];
  for (const row of rows) for (const button of row) if (button.text === label) return button.callback_data;
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

export async function startFakeTelegram(port = 0, host = '127.0.0.1'): Promise<FakeTelegram> {
  const calls: FakeTelegramCall[] = [];
  const webhooks = new Map<string, FakeWebhook>();
  const failNext: Record<string, number> = {};
  const files = new Map<string, { path: string; data: Buffer; mime: string }>();
  let fileSeq = 0;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '';
    const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(url);
    if (req.method === 'GET' && download) {
      const file = [...files.values()].find((f) => f.path === download[2]);
      if (!file) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      res.setHeader('content-type', file.mime);
      res.end(file.data);
      return;
    }
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    const raw = await readBody(req);
    if (!match) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = match as unknown as [string, string, string];
    let body: Record<string, any> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    calls.push({ method, token, body });
    const failures = failNext[method] ?? 0;
    if (failures > 0) {
      failNext[method] = failures - 1;
      return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided' });
    }
    switch (method) {
      case 'sendMessage':
        return json(res, 200, { ok: true, result: { message_id: calls.length, chat: { id: body.chat_id }, text: body.text } });
      case 'setWebhook':
        webhooks.set(token, { url: String(body.url), secret: String(body.secret_token ?? ''), allowedUpdates: body.allowed_updates ?? [] });
        return json(res, 200, { ok: true, result: true, description: 'Webhook was set' });
      case 'deleteWebhook':
        webhooks.delete(token);
        return json(res, 200, { ok: true, result: true, description: 'Webhook was deleted' });
      case 'sendChatAction':
      case 'answerCallbackQuery':
        return json(res, 200, { ok: true, result: true });
      case 'getFile': {
        const file = files.get(String(body.file_id));
        if (!file) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
        return json(res, 200, { ok: true, result: { file_id: body.file_id, file_size: file.data.length, file_path: file.path } });
      }
      default:
        return json(res, 200, { ok: true, result: true });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    port: address.port,
    calls,
    webhooks,
    failNext,
    addFile: (data, mime, ext = 'bin') => {
      fileSeq += 1;
      const id = `file${Date.now().toString(36)}${fileSeq}`;
      files.set(id, { path: `files/${id}.${ext}`, data, mime });
      return id;
    },
    messagesTo: (chatId) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* Execução direta: `node e2e/fakes/fake-telegram.ts 18081` (para testar o console à mão). */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 18081);
  void startFakeTelegram(port, '0.0.0.0').then((fake) => console.log(`Bot API falsa em ${fake.url}`));
}
