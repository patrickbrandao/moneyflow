import {
  accountCategoryEntriesQuery,
  accountCreateInput,
  accountSummaryQuery,
  accountUpdateInput,
  adjustmentInput,
  caixaCreateInput,
  caixaUpdateInput,
  categoryCreateInput,
  categoryUpdateInput,
  hiddenCategoriesInput,
  memberInput,
  memberUpdateInput,
  obligationMatchQuery,
  queryBool,
  statementQuery,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { param, parse, type Req } from '../http';
import * as caixas from '../services/caixas';
import * as categories from '../services/categories';
import { accountCategoryEntries, accountStatement, accountSummary } from '../services/statement';
import { obligationMatches } from '../services/statements';

const archivedQuery = z.object({ archived: queryBool });
const accountsQuery = z.object({ archived: queryBool, writable: queryBool, caixaId: z.uuid().optional() });
const categoryQuery = z.object({ caixaId: z.uuid().optional(), kind: z.enum(['income', 'expense']).optional(), archived: queryBool });

export async function caixaRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/caixas', (r: Req) => caixas.listCaixas(r.ctx, parse(archivedQuery, r.query)));
  app.post('/api/caixas', (r: Req) => caixas.createCaixa(r.ctx, parse(caixaCreateInput, r.body)));
  app.get('/api/caixas/:id', (r: Req) => caixas.getCaixa(r.ctx, id(r)));
  app.patch('/api/caixas/:id', (r: Req) => caixas.updateCaixa(r.ctx, id(r), parse(caixaUpdateInput, r.body)));
  app.delete('/api/caixas/:id', (r: Req) => caixas.deleteCaixa(r.ctx, id(r)));
  app.post('/api/caixas/:id/restore', (r: Req) => caixas.restoreCaixa(r.ctx, id(r)));

  app.get('/api/caixas/:id/members', (r: Req) => caixas.listMembers(r.ctx, id(r)));
  app.post('/api/caixas/:id/members', (r: Req) => caixas.addMember(r.ctx, id(r), parse(memberInput, r.body)));
  app.patch('/api/caixas/:id/members/:memberId', (r: Req) =>
    caixas.updateMember(r.ctx, id(r), param(r, 'memberId'), parse(memberUpdateInput, r.body)),
  );
  app.delete('/api/caixas/:id/members/:memberId', (r: Req) => caixas.removeMember(r.ctx, id(r), param(r, 'memberId')));

  app.get('/api/caixas/:id/hidden-categories', (r: Req) => caixas.getHiddenCategories(r.ctx, id(r)));
  app.put('/api/caixas/:id/hidden-categories', (r: Req) => caixas.setHiddenCategories(r.ctx, id(r), parse(hiddenCategoriesInput, r.body)));

  app.get('/api/accounts', (r: Req) => caixas.listAccounts(r.ctx, parse(accountsQuery, r.query)));
  app.post('/api/caixas/:id/accounts', (r: Req) => caixas.createAccount(r.ctx, id(r), parse(accountCreateInput, r.body)));
  app.patch('/api/accounts/:id', (r: Req) => caixas.updateAccount(r.ctx, id(r), parse(accountUpdateInput, r.body)));
  app.delete('/api/accounts/:id', (r: Req) => caixas.deleteAccount(r.ctx, id(r)));
  app.post('/api/accounts/:id/restore', async (r: Req) => {
    await caixas.restoreAccount(r.ctx, id(r));
    return { ok: true };
  });
  app.get('/api/accounts/:id/statement', (r: Req) => accountStatement(r.ctx, id(r), parse(statementQuery, r.query)));
  app.get('/api/accounts/:id/summary', (r: Req) => accountSummary(r.ctx, id(r), parse(accountSummaryQuery, r.query)));
  app.get('/api/accounts/:id/category-entries', (r: Req) =>
    accountCategoryEntries(r.ctx, id(r), parse(accountCategoryEntriesQuery, r.query)),
  );
  app.post('/api/accounts/:id/adjustments', (r: Req) => caixas.addAdjustment(r.ctx, id(r), parse(adjustmentInput, r.body)));
  // "É o pagamento de…?" (spec 034): ocorrências em aberto da conta que o lançamento avulso pode baixar.
  app.get('/api/accounts/:id/obligation-matches', (r: Req) => obligationMatches(r.ctx, id(r), parse(obligationMatchQuery, r.query)));
  app.delete('/api/movements/:id', async (r: Req) => {
    await caixas.deleteAdjustment(r.ctx, id(r));
    return { deleted: true, archived: false };
  });

  app.get('/api/categories', (r: Req) => categories.categoryTree(r.ctx, parse(categoryQuery, r.query)));
  app.post('/api/categories', (r: Req) => categories.createCategory(r.ctx, parse(categoryCreateInput, r.body)));
  app.patch('/api/categories/:id', (r: Req) => categories.updateCategory(r.ctx, id(r), parse(categoryUpdateInput, r.body)));
  app.delete('/api/categories/:id', (r: Req) => categories.deleteCategory(r.ctx, id(r)));
  app.post('/api/categories/:id/restore', async (r: Req) => {
    await categories.restoreCategory(r.ctx, id(r));
    return { ok: true };
  });
}
