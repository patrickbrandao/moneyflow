import { type RECIPE_TOOLS, type ToolPreview, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import * as recipes from '../services/reconcile-recipes';
import { getImport } from '../services/statements';
import type { Handlers } from './tool-helpers';

/*
 * Tools das receitas de conciliação (spec 030, categoria Conciliação), sobre o
 * serviço (o Access decide: caixa dona para editar, admin para as globais).
 * Escritas com prévia: dona, agente, contas e a instrução.
 */

type RecipeToolName = (typeof RECIPE_TOOLS)[number]['name'];

const yesNo = (v: boolean) => (v ? 'Sim' : 'Não');

async function agentName(ctx: ServiceContext, id: string) {
  const r = await ctx.db.execute<{ name: string; has_kit: boolean }>(
    sql`SELECT name, tool_kit_id IS NOT NULL AS has_kit FROM ai_agents WHERE id = ${id}`,
  );
  return r.rows[0] ?? { name: id, has_kit: true };
}

async function ownerName(ctx: ServiceContext, caixaId: string | null) {
  if (caixaId === null) return 'Global';
  if (!ctx.access.canRead(caixaId)) return caixaId;
  const r = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM caixas WHERE id = ${caixaId}`);
  return r.rows[0]?.name ?? caixaId;
}

async function targetNames(ctx: ServiceContext, accountIds: string[], cardIds: string[]) {
  if (accountIds.length + cardIds.length === 0) return 'Nenhuma (todos os lotes da dona)';
  const r = await ctx.db.execute<{ name: string }>(sql`
    SELECT name FROM financial_accounts WHERE id = ANY (${`{${accountIds.join(',')}}`}::uuid[])
    UNION ALL SELECT name FROM caixas WHERE id = ANY (${`{${cardIds.join(',')}}`}::uuid[])`);
  return r.rows.map((x) => x.name).join(', ');
}

export const RECIPE_HANDLERS: Handlers<RecipeToolName> = {
  list_reconcile_recipes: {
    run: (ctx, i) =>
      recipes.listRecipes(ctx, {
        caixaId: i.caixaId,
        accountId: i.accountId,
        cardCaixaId: i.cardCaixaId,
        archived: i.archived ? 'true' : undefined,
      }),
  },
  create_reconcile_recipe: {
    preview: async (ctx, i) => {
      if (i.caixaId === null) ctx.access.assertAdmin();
      else ctx.access.assertWrite(i.caixaId);
      const agent = await agentName(ctx, i.agentId);
      return {
        title: 'Criar receita de conciliação',
        summary: i.name,
        action: 'create',
        rows: [
          { label: 'Dona', after: await ownerName(ctx, i.caixaId) },
          { label: 'Agente', after: agent.name },
          { label: 'Contas', after: await targetNames(ctx, i.accountIds, i.cardCaixaIds) },
          { label: 'Rodar ao importar', after: yesNo(i.runOnImport) },
          { label: 'Instrução', after: i.instruction.slice(0, 500) },
        ],
        warnings: agent.has_kit ? [] : [t.agents.recipes.noKit(agent.name)],
      };
    },
    run: (ctx, i) => recipes.createRecipe(ctx, i),
  },
  update_reconcile_recipe: {
    preview: async (ctx, i) => {
      const recipe = await recipes.getRecipe(ctx, i.recipeId);
      if (!recipe.canEdit) {
        if (recipe.caixaId === null) ctx.access.assertAdmin();
        else ctx.access.assertWrite(recipe.caixaId);
      }
      const c = i.changes;
      const rows: ToolPreview['rows'] = [];
      const warnings: string[] = [];
      if (c.name !== undefined && c.name !== recipe.name) rows.push({ label: 'Nome', before: recipe.name, after: c.name });
      if (c.agentId !== undefined && c.agentId !== recipe.agentId) {
        const agent = await agentName(ctx, c.agentId);
        rows.push({ label: 'Agente', before: recipe.agentName, after: agent.name });
        if (!agent.has_kit) warnings.push(t.agents.recipes.noKit(agent.name));
      }
      if (c.accountIds !== undefined || c.cardCaixaIds !== undefined) {
        const accounts = c.accountIds ?? recipe.targets.filter((x) => x.kind === 'account').map((x) => x.id);
        const cards = c.cardCaixaIds ?? recipe.targets.filter((x) => x.kind === 'card').map((x) => x.id);
        rows.push({
          label: 'Contas',
          before: recipe.targets.map((x) => x.name).join(', ') || '—',
          after: await targetNames(ctx, accounts, cards),
        });
      }
      if (c.instruction !== undefined && c.instruction !== recipe.instruction) {
        rows.push({ label: 'Instrução', before: recipe.instruction.slice(0, 300), after: c.instruction.slice(0, 500) });
      }
      if (c.runOnImport !== undefined && c.runOnImport !== recipe.runOnImport) {
        rows.push({ label: 'Rodar ao importar', before: yesNo(recipe.runOnImport), after: yesNo(c.runOnImport) });
      }
      if (c.position !== undefined && c.position !== recipe.position)
        rows.push({ label: 'Ordem', before: String(recipe.position), after: String(c.position) });
      if (c.isActive !== undefined && c.isActive !== recipe.isActive) {
        rows.push({ label: 'Ativa', before: yesNo(recipe.isActive), after: yesNo(c.isActive) });
      }
      return {
        title: 'Editar receita de conciliação',
        summary: `${recipe.name} (${recipe.caixaName ?? 'Global'})`,
        action: 'update',
        rows,
        warnings,
      };
    },
    run: (ctx, i) => recipes.updateRecipe(ctx, i.recipeId, i.changes),
  },
  archive_reconcile_recipe: {
    preview: async (ctx, i) => {
      const recipe = await recipes.getRecipe(ctx, i.recipeId);
      if (!recipe.canEdit) {
        if (recipe.caixaId === null) ctx.access.assertAdmin();
        else ctx.access.assertWrite(recipe.caixaId);
      }
      return {
        title: 'Arquivar receita de conciliação',
        summary: `${recipe.name} (${recipe.caixaName ?? 'Global'})`,
        action: 'delete',
        rows: [
          { label: 'Agente', after: recipe.agentName },
          { label: 'Contas', after: recipe.targets.map((x) => x.name).join(', ') || '—' },
        ],
        warnings: ['A receita sai das listas e da fila do import; o histórico de execuções fica.'],
      };
    },
    run: (ctx, i) => recipes.archiveRecipe(ctx, i.recipeId),
  },
  run_reconcile_recipe: {
    preview: async (ctx, i) => {
      const recipe = await recipes.getRecipe(ctx, i.recipeId);
      const detail = await getImport(ctx, i.statementImportId);
      ctx.access.assertWrite(detail.caixaId);
      const pending = detail.lines.filter((l) => l.status === 'new' || l.status === 'suggested').length;
      const agent = await agentName(ctx, recipe.agentId);
      return {
        title: 'Rodar receita de conciliação',
        summary: `${recipe.name} · ${detail.fileName}`,
        action: 'other',
        rows: [
          { label: 'Dona', after: recipe.caixaName ?? 'Global' },
          { label: 'Agente', after: recipe.agentName },
          { label: 'Linhas', after: i.lineIds ? `${i.lineIds.length} selecionada(s)` : `${pending} pendente(s)` },
          { label: 'Instrução', after: recipe.instruction.slice(0, 500) },
        ],
        warnings: [t.agents.recipes.previewWarning, ...(agent.has_kit ? [] : [t.agents.recipes.noKit(agent.name)])],
      };
    },
    run: (ctx, i) => recipes.runRecipe(ctx, i.statementImportId, i.recipeId, i.lineIds),
  },
};
