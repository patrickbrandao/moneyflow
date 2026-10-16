import {
  reconcileRecipeCreateInput,
  reconcileRecipeListQuery,
  reconcileRecipeRunInput,
  reconcileRecipeUpdateInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import * as recipes from '../services/reconcile-recipes';

/* Receitas de conciliação (spec 030): cadastro, histórico e o play na tela do lote. */
export async function reconcileRecipeRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/reconcile-recipes', (r: Req) => recipes.listRecipes(r.ctx, parse(reconcileRecipeListQuery, r.query)));
  app.post('/api/reconcile-recipes', (r: Req) => recipes.createRecipe(r.ctx, parse(reconcileRecipeCreateInput, r.body)));
  app.get('/api/reconcile-recipes/:id', (r: Req) => recipes.getRecipe(r.ctx, id(r)));
  app.patch('/api/reconcile-recipes/:id', (r: Req) => recipes.updateRecipe(r.ctx, id(r), parse(reconcileRecipeUpdateInput, r.body)));
  app.delete('/api/reconcile-recipes/:id', (r: Req) => recipes.archiveRecipe(r.ctx, id(r)));
  app.post('/api/reconcile-recipes/:id/restore', (r: Req) => recipes.restoreRecipe(r.ctx, id(r)));
  app.get('/api/reconcile-recipes/:id/runs', (r: Req) => recipes.listRecipeRuns(r.ctx, id(r)));

  app.get('/api/statement-imports/:id/recipes', (r: Req) => recipes.importRecipes(r.ctx, id(r)));
  app.post('/api/statement-imports/:id/recipes/:recipeId/run', (r: Req) =>
    recipes.runRecipe(r.ctx, id(r), param(r, 'recipeId'), parse(reconcileRecipeRunInput, r.body ?? {}).lineIds),
  );
}
