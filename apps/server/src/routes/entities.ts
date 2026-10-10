import {
  addressInput,
  bankAccountInput,
  contactInput,
  entityCreateInput,
  entityListQuery,
  entityUpdateInput,
  linkInput,
  pixKeyInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import { lookupCep, lookupCnpj } from '../integrations/lookup';
import * as entities from '../services/entities';

export async function entityRoutes(app: FastifyInstance) {
  app.get('/api/entities', (request: Req) => entities.listEntities(request.ctx, parse(entityListQuery, request.query)));
  app.post('/api/entities', (request: Req) => entities.createEntity(request.ctx, parse(entityCreateInput, request.body)));
  app.get('/api/entities/:id', (request: Req) => entities.getEntity(request.ctx, param(request, 'id')));
  app.patch('/api/entities/:id', (request: Req) =>
    entities.updateEntity(request.ctx, param(request, 'id'), parse(entityUpdateInput, request.body)),
  );
  app.delete('/api/entities/:id', (request: Req) => entities.deleteEntity(request.ctx, param(request, 'id')));
  app.post('/api/entities/:id/restore', (request: Req) => entities.restoreEntity(request.ctx, param(request, 'id')));

  const id = (r: Req) => param(r, 'id');
  const child = (r: Req) => param(r, 'childId');

  app.post('/api/entities/:id/contacts', (r: Req) => entities.addContact(r.ctx, id(r), parse(contactInput, r.body)));
  app.put('/api/entities/:id/contacts/:childId', (r: Req) => entities.updateContact(r.ctx, id(r), child(r), parse(contactInput, r.body)));
  app.delete('/api/entities/:id/contacts/:childId', (r: Req) => entities.deleteContact(r.ctx, id(r), child(r)));

  app.post('/api/entities/:id/addresses', (r: Req) => entities.addAddress(r.ctx, id(r), parse(addressInput, r.body)));
  app.put('/api/entities/:id/addresses/:childId', (r: Req) => entities.updateAddress(r.ctx, id(r), child(r), parse(addressInput, r.body)));
  app.delete('/api/entities/:id/addresses/:childId', (r: Req) => entities.deleteAddress(r.ctx, id(r), child(r)));

  app.post('/api/entities/:id/bank-accounts', (r: Req) => entities.addBankAccount(r.ctx, id(r), parse(bankAccountInput, r.body)));
  app.put('/api/entities/:id/bank-accounts/:childId', (r: Req) =>
    entities.updateBankAccount(r.ctx, id(r), child(r), parse(bankAccountInput, r.body)),
  );
  app.delete('/api/entities/:id/bank-accounts/:childId', (r: Req) => entities.deleteBankAccount(r.ctx, id(r), child(r)));

  app.post('/api/entities/:id/pix-keys', (r: Req) => entities.addPixKey(r.ctx, id(r), parse(pixKeyInput, r.body)));
  app.put('/api/entities/:id/pix-keys/:childId', (r: Req) => entities.updatePixKey(r.ctx, id(r), child(r), parse(pixKeyInput, r.body)));
  app.delete('/api/entities/:id/pix-keys/:childId', (r: Req) => entities.deletePixKey(r.ctx, id(r), child(r)));

  app.post('/api/entities/:id/links', (r: Req) => entities.addLink(r.ctx, id(r), parse(linkInput, r.body)));
  app.delete('/api/entities/:id/links/:childId', (r: Req) => entities.deleteLink(r.ctx, id(r), child(r)));

  app.get('/api/lookup/cnpj/:value', (r: Req) => lookupCnpj(r.params.value ?? '', app.config.lookupTimeoutMs));
  app.get('/api/lookup/cep/:value', (r: Req) => lookupCep(r.params.value ?? '', app.config.lookupTimeoutMs));
}
