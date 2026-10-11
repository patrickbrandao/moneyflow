import {
  canvasPositionsInput,
  destinationCreateInput,
  destinationUpdateInput,
  flowLinesQuery,
  flowQuery,
  MESSAGE_EVENT_KINDS,
  notificationQuery,
  outboxQuery,
  projectionQuery,
  reportQuery,
  subscriptionInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { param, parse, type Req } from '../http';
import * as flow from '../services/flow';
import * as messages from '../services/messages';
import * as notifications from '../services/notifications';
import * as reports from '../services/reports';

const eventKind = z.enum(MESSAGE_EVENT_KINDS);

/* Fase 3: relatórios e canvas de fluxo (spec 014), mensagens (013) e o sino. */
export async function visionRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/reports/categories', (r: Req) => reports.categoryReport(r.ctx, parse(reportQuery, r.query)));
  app.get('/api/reports/entities', (r: Req) => reports.entityReport(r.ctx, parse(reportQuery, r.query)));
  app.get('/api/reports/projection', (r: Req) => reports.projectionReport(r.ctx, parse(projectionQuery, r.query)));

  app.get('/api/flow', (r: Req) => flow.flowGraph(r.ctx, parse(flowQuery, r.query)));
  app.get('/api/flow/lines', (r: Req) => flow.flowLines(r.ctx, parse(flowLinesQuery, r.query)));
  app.put('/api/flow/positions', (r: Req) => flow.savePositions(r.ctx, parse(canvasPositionsInput, r.body)));
  app.delete('/api/flow/positions', (r: Req) => flow.resetPositions(r.ctx));

  app.get('/api/message-destinations', (r: Req) => messages.listDestinations(r.ctx));
  app.post('/api/message-destinations', (r: Req) => messages.createDestination(r.ctx, parse(destinationCreateInput, r.body)));
  app.get('/api/message-destinations/:id', (r: Req) => messages.getDestination(r.ctx, id(r)));
  app.patch('/api/message-destinations/:id', (r: Req) => messages.updateDestination(r.ctx, id(r), parse(destinationUpdateInput, r.body)));
  app.delete('/api/message-destinations/:id', (r: Req) => messages.deleteDestination(r.ctx, id(r)));
  app.post('/api/message-destinations/:id/restore', (r: Req) => messages.restoreDestination(r.ctx, id(r)));
  app.post('/api/message-destinations/:id/test', (r: Req) => messages.sendTest(r.ctx, id(r)));
  app.get('/api/message-destinations/:id/subscriptions', (r: Req) => messages.listSubscriptions(r.ctx, id(r)));
  app.put('/api/message-destinations/:id/subscriptions', (r: Req) =>
    messages.upsertSubscription(r.ctx, id(r), parse(subscriptionInput, r.body)),
  );
  app.delete('/api/message-destinations/:id/subscriptions/:kind', (r: Req) =>
    messages.deleteSubscription(r.ctx, id(r), parse(eventKind, r.params.kind)),
  );
  app.get('/api/message-outbox', (r: Req) => messages.listOutbox(r.ctx, parse(outboxQuery, r.query)));
  app.post('/api/message-outbox/:id/resend', (r: Req) => messages.resendMessage(r.ctx, id(r)));
  app.post('/api/message-outbox/:id/cancel', (r: Req) => messages.cancelMessage(r.ctx, id(r)));

  app.get('/api/notifications', (r: Req) => notifications.listNotifications(r.ctx, parse(notificationQuery, r.query)));
  app.post('/api/notifications/read-all', (r: Req) => notifications.markAllRead(r.ctx));
  app.post('/api/notifications/:id/read', (r: Req) => notifications.markRead(r.ctx, id(r)));
}
