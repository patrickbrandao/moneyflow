import { telegramLinksQuery, telegramPairingInput } from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import * as telegram from '../services/telegram-inbound';

/* Telegram de entrada (spec 029): o webhook (sem sessão, pelo segredo), o pareamento em Minha conta e a configuração. */
export async function telegramRoutes(app: FastifyInstance) {
  app.post('/api/telegram/webhook/:destinationId', async (r: Req, reply) => {
    const destinationId = param(r, 'destinationId');
    const header = r.headers['x-telegram-bot-api-secret-token'];
    const secret = Array.isArray(header) ? (header[0] ?? null) : (header ?? null);
    if (!(await telegram.authenticateWebhook(app.db, destinationId, secret))) {
      return reply.status(401).send({ error: { code: 'unauthenticated', message: 'unauthorized' } });
    }
    await telegram.handleUpdate({ db: app.db, config: app.config, log: r.log }, destinationId, (r.body ?? {}) as telegram.TelegramUpdate);
    return { ok: true };
  });

  app.get('/api/message-destinations/inbound-config', (r: Req) => telegram.inboundConfig(r.ctx));
  app.get('/api/account/telegram', (r: Req) => telegram.accountTelegram(r.ctx, parse(telegramLinksQuery, r.query).all === 'true'));
  app.post('/api/account/telegram/pairing-codes', (r: Req) =>
    telegram.createPairingCode(r.ctx, parse(telegramPairingInput, r.body).destinationId),
  );
  app.delete('/api/account/telegram/links/:id', (r: Req) => telegram.revokeLink(r.ctx, param(r, 'id')));
}
