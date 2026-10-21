import {
  mirrorAcceptInput,
  mirrorDisputeInput,
  seriesCreateInput,
  seriesEndInput,
  seriesEndQuery,
  seriesListQuery,
  seriesUpdateInput,
  settlementAccountInput,
  settlementCreateInput,
  settlementReverseInput,
  titleCreateInput,
  titleDeleteQuery,
  titleListQuery,
  titleUpdateInput,
  transferCreateInput,
  transferListQuery,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import { overview, search } from '../services/overview';
import * as series from '../services/series';
import * as settlements from '../services/settlements';
import * as titles from '../services/titles';
import * as transfers from '../services/transfers';

export async function titleRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/titles', (r: Req) => titles.listTitles(r.ctx, parse(titleListQuery, r.query)));
  app.post('/api/titles', (r: Req) => titles.createTitle(r.ctx, parse(titleCreateInput, r.body)));
  app.get('/api/titles/:id', (r: Req) => titles.getTitle(r.ctx, id(r)));
  app.patch('/api/titles/:id', (r: Req) => titles.updateTitle(r.ctx, id(r), parse(titleUpdateInput, r.body)));
  app.delete('/api/titles/:id', (r: Req) => titles.deleteTitle(r.ctx, id(r), parse(titleDeleteQuery, r.query).scope));
  app.post('/api/titles/:id/restore', (r: Req) => titles.restoreTitle(r.ctx, id(r)));
  app.post('/api/titles/:id/cancel', (r: Req) => titles.cancelTitle(r.ctx, id(r)));
  app.post('/api/titles/:id/reopen', (r: Req) => titles.reopenTitle(r.ctx, id(r)));
  app.get('/api/titles/:id/series/end', (r: Req) => titles.previewSeriesEnd(r.ctx, id(r), parse(seriesEndQuery, r.query).endsOn ?? null));
  app.post('/api/titles/:id/series/end', (r: Req) => titles.endSeries(r.ctx, id(r), parse(seriesEndInput, r.body).endsOn));
  // Séries com conta, cartão e ajustes (spec 034): a obrigação de um contrato ou uma série solta.
  app.get('/api/series', (r: Req) => series.listSeries(r.ctx, parse(seriesListQuery, r.query)));
  app.post('/api/series', (r: Req) => series.createSeries(r.ctx, parse(seriesCreateInput, r.body)));
  app.get('/api/series/:id', (r: Req) => series.getSeries(r.ctx, id(r)));
  app.patch('/api/series/:id', (r: Req) => series.updateSeries(r.ctx, id(r), parse(seriesUpdateInput, r.body)));
  app.get('/api/series/:id/end', (r: Req) => series.previewSeriesEndRule(r.ctx, id(r), parse(seriesEndQuery, r.query).endsOn ?? null));
  app.post('/api/series/:id/end', (r: Req) => series.endSeriesRule(r.ctx, id(r), parse(seriesEndInput, r.body).endsOn));
  app.post('/api/titles/:id/mirror/accept', (r: Req) => titles.acceptMirror(r.ctx, id(r), parse(mirrorAcceptInput, r.body)));
  app.post('/api/titles/:id/mirror/dispute', (r: Req) => titles.disputeMirror(r.ctx, id(r), parse(mirrorDisputeInput, r.body)));

  app.post('/api/titles/:id/settlements', (r: Req) => settlements.createSettlement(r.ctx, id(r), parse(settlementCreateInput, r.body)));
  app.post('/api/settlements/:id/account', (r: Req) =>
    settlements.setSettlementAccount(r.ctx, id(r), parse(settlementAccountInput, r.body)),
  );
  app.post('/api/settlements/:id/reverse', (r: Req) => settlements.reverseSettlement(r.ctx, id(r), parse(settlementReverseInput, r.body)));

  app.get('/api/transfers', (r: Req) => transfers.listTransfers(r.ctx, parse(transferListQuery, r.query)));
  app.post('/api/transfers', (r: Req) => transfers.createTransfer(r.ctx, parse(transferCreateInput, r.body)));
  app.get('/api/transfers/:id', (r: Req) => transfers.getTransfer(r.ctx, id(r)));
  app.delete('/api/transfers/:id', async (r: Req) => {
    await transfers.deleteTransfer(r.ctx, id(r));
    return { deleted: true, archived: false };
  });

  app.get('/api/overview', (r: Req) => overview(r.ctx));
  app.get('/api/search', (r: Req) => search(r.ctx, String(r.query.q ?? '')));
}
