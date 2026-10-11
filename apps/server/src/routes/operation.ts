import {
  auditListQuery,
  auditRecordQuery,
  balancesQuery,
  calendarQuery,
  monthStart,
  nfeEntryQuery,
  periodClosingInput,
  pixEntryInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import { assertUpload } from '../services/attachments';
import * as audit from '../services/audit';
import * as calendar from '../services/calendar';
import * as entry from '../services/title-entry';
import { UPLOAD_BODY_LIMIT } from './attachments';

/* Auditoria e fechamento (spec 008), entrada de títulos (010) e calendário (012). */
export async function operationRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/audit/record', (r: Req) => {
    const q = parse(auditRecordQuery, r.query);
    return audit.recordHistory(r.ctx, q.table, q.recordId);
  });
  app.get('/api/audit', (r: Req) => audit.auditLog(r.ctx, parse(auditListQuery, r.query)));

  app.get('/api/caixas/:id/closings', (r: Req) => audit.closingsOverview(r.ctx, id(r)));
  app.post('/api/caixas/:id/closings', (r: Req) => audit.closeMonth(r.ctx, id(r), parse(periodClosingInput, r.body)));
  app.delete('/api/caixas/:id/closings/:month', (r: Req) => audit.reopenMonth(r.ctx, id(r), parse(monthStart, r.params.month)));

  app.post('/api/title-entry/pix', (r: Req) => entry.pixEntry(r.ctx, parse(pixEntryInput, r.body)));
  app.post('/api/title-entry/nfe', { bodyLimit: UPLOAD_BODY_LIMIT }, (r: Req) =>
    entry.nfeEntry(r.ctx, {
      name: parse(nfeEntryQuery, r.query).fileName,
      mime: r.headers['content-type'] ?? '',
      content: assertUpload(r.body),
    }),
  );
  app.post('/api/title-entry/document', { bodyLimit: UPLOAD_BODY_LIMIT }, (r: Req) =>
    entry.readDocument(r.ctx, {
      name: String(r.query.fileName ?? 'documento'),
      mime: r.headers['content-type'] ?? '',
      content: assertUpload(r.body),
    }),
  );
  app.get('/api/nfe/:id', (r: Req) => entry.getNfe(r.ctx, id(r)));

  app.get('/api/calendar', (r: Req) => calendar.calendarItems(r.ctx, parse(calendarQuery, r.query)));
  app.get('/api/calendar/balances', (r: Req) => calendar.dailyBalances(r.ctx, parse(balancesQuery, r.query)));
}
