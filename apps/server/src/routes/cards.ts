import {
  cardChargeInput,
  cardChargeLinkInput,
  cardExpectedChargesQuery,
  cardPurchaseInput,
  cardPurchaseListQuery,
  cardPurchaseUpdateInput,
  cardRefundInput,
  invoiceAdvanceInput,
  invoiceCloseInput,
  invoicePaymentInput,
  invoiceUpdateInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { param, parse, type Req } from '../http';
import * as cards from '../services/cards';

const invoiceQuery = z.object({ payerCaixaId: z.uuid().optional() });

/* Cartão de crédito (spec 007). */
export async function cardRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/cards/:id', (r: Req) => cards.cardOverview(r.ctx, id(r)));
  app.get('/api/cards/:id/purchases', (r: Req) => cards.listPurchases(r.ctx, id(r), parse(cardPurchaseListQuery, r.query)));
  app.post('/api/cards/:id/purchases', (r: Req) => cards.createPurchase(r.ctx, id(r), parse(cardPurchaseInput, r.body)));
  app.post('/api/cards/:id/charges', (r: Req) => cards.createCharge(r.ctx, id(r), parse(cardChargeInput, r.body)));
  // Cobranças esperadas das obrigações no cartão (spec 034): "É cobrança de um contrato?".
  app.get('/api/cards/:id/expected-charges', (r: Req) => cards.expectedCharges(r.ctx, id(r), parse(cardExpectedChargesQuery, r.query)));

  app.get('/api/card-purchases/:id', (r: Req) => cards.getPurchase(r.ctx, id(r)));
  app.patch('/api/card-purchases/:id', (r: Req) => cards.updatePurchase(r.ctx, id(r), parse(cardPurchaseUpdateInput, r.body)));
  app.delete('/api/card-purchases/:id', (r: Req) => cards.deletePurchase(r.ctx, id(r)));
  app.post('/api/card-purchases/:id/charge-link', (r: Req) => cards.linkPurchaseCharge(r.ctx, id(r), parse(cardChargeLinkInput, r.body)));
  app.post('/api/card-purchases/:id/refund', (r: Req) => cards.refundPurchase(r.ctx, id(r), parse(cardRefundInput, r.body)));

  app.get('/api/card-invoices/:id', (r: Req) => cards.getInvoice(r.ctx, id(r), parse(invoiceQuery, r.query).payerCaixaId));
  app.patch('/api/card-invoices/:id', (r: Req) => cards.updateInvoice(r.ctx, id(r), parse(invoiceUpdateInput, r.body)));
  app.post('/api/card-invoices/:id/close', (r: Req) => cards.closeInvoice(r.ctx, id(r), parse(invoiceCloseInput, r.body)));
  app.post('/api/card-invoices/:id/reopen', (r: Req) => cards.reopenInvoice(r.ctx, id(r)));
  app.post('/api/card-invoices/:id/pay', (r: Req) => cards.payInvoice(r.ctx, id(r), parse(invoicePaymentInput, r.body)));
  app.post('/api/card-invoices/:id/advance', (r: Req) => cards.advanceInvoice(r.ctx, id(r), parse(invoiceAdvanceInput, r.body)));
}
