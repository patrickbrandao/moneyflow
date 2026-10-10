import { membershipsSetInput, userCreateInput, userUpdateInput } from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import * as users from '../services/users';

export async function userRoutes(app: FastifyInstance) {
  app.get('/api/users', (request) => users.listUsers(request.ctx));
  app.post('/api/users', (request: Req) => users.createUser(request.ctx, parse(userCreateInput, request.body)));
  app.get('/api/users/:id', (request: Req) => users.getUser(request.ctx, param(request, 'id')));
  app.patch('/api/users/:id', (request: Req) => users.updateUser(request.ctx, param(request, 'id'), parse(userUpdateInput, request.body)));
  app.delete('/api/users/:id', async (request: Req) => {
    await users.deleteUser(request.ctx, param(request, 'id'));
    return { deleted: true, archived: false };
  });
  app.post('/api/users/:id/reveal-password', async (request: Req, reply) => {
    reply.header('cache-control', 'no-store');
    return { password: await users.revealPassword(request.ctx, param(request, 'id')) };
  });
  app.put('/api/users/:id/memberships', (request: Req) =>
    users.setMemberships(request.ctx, param(request, 'id'), parse(membershipsSetInput, request.body)),
  );
}
