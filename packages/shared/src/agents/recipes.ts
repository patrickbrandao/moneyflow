import { z } from 'zod';
import { id } from '../schemas/common';
import { scanRecipeVariables } from './prompt-vars';
import { define } from './tool-def';
import type { AiRunStatus } from './types';

/*
 * Receitas de conciliação (spec 030): entradas da API e das tools, DTOs, o
 * motivo das execuções puladas e as tools. Sem banco: a API e o console
 * importam daqui.
 */

/** Limites do banco: 50 receitas não arquivadas por dona e 10 "rodar ao importar" por conta/cartão. */
export const RECONCILE_RECIPE_LIMIT = 50;
export const RECONCILE_RECIPE_IMPORT_LIMIT = 10;
export const RECONCILE_RECIPE_INSTRUCTION_MAX = 20_000;

/** Recusa as variáveis desconhecidas da instrução (`{{x}}`), como o prompt do agente. */
const instruction = z
  .string()
  .trim()
  .min(1)
  .max(RECONCILE_RECIPE_INSTRUCTION_MAX)
  .superRefine((text, ctx) => {
    const { unknown } = scanRecipeVariables(text);
    if (unknown.length > 0) {
      ctx.addIssue({ code: 'custom', message: `Variável desconhecida: ${unknown.map((name) => `{{${name}}}`).join(', ')}` });
    }
  })
  .describe('Texto enviado ao agente como mensagem do usuário (até 20 mil caracteres), com as variáveis {{…}} do lote.');

const ids = z.array(id).max(50);

export const reconcileRecipeCreateInput = z.object({
  caixaId: id.nullable().describe('Caixa dona (quem escreve nela edita); null = receita global (só administrador).'),
  agentId: id.describe('Agente que executa a receita (o kit dele decide o que roda direto e o que espera aprovação).'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  instruction,
  accountIds: ids.default([]).describe('Contas correntes/poupança vinculadas (da caixa dona; a global vincula qualquer uma).'),
  cardCaixaIds: ids.default([]).describe('Cartões vinculados (o próprio cartão dono ou um cartão cuja pagadora padrão é a dona).'),
  runOnImport: z.boolean().default(false).describe('Rodar ao importar (exige conta ou cartão vinculado).'),
  position: z.number().int().min(0).max(100_000).default(0).describe('Ordem (menor primeiro) na lista e na fila do import.'),
  isActive: z.boolean().default(true),
});

export const reconcileRecipeUpdateInput = z.object({
  agentId: id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullish(),
  instruction: instruction.optional(),
  accountIds: ids.optional(),
  cardCaixaIds: ids.optional(),
  runOnImport: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});

export const reconcileRecipeListQuery = z.object({
  /** Uma caixa, 'global' (só as globais) ou omitido (todas as visíveis). */
  caixaId: z.union([id, z.literal('global')]).optional(),
  /** Conta ou cartão vinculado. */
  accountId: id.optional(),
  cardCaixaId: id.optional(),
  archived: z.enum(['true', 'false']).optional(),
});

export const reconcileRecipeRunInput = z.object({
  lineIds: z.array(id).min(1).max(500).optional().describe('Linhas do lote (omitido = todas as pendentes: novas e sugeridas).'),
});

export type ReconcileRecipeRunStatus = 'queued' | 'started' | 'completed' | 'skipped' | 'failed';

export type ReconcileRecipeTargetDto = { kind: 'account' | 'card'; id: string; name: string; caixaId: string };

export type ReconcileRecipeRunDto = {
  id: string;
  recipeId: string;
  recipeName: string;
  importId: string;
  fileName: string;
  /** Para o link do lote. */
  caixaId: string;
  financialAccountId: string | null;
  cardCaixaId: string | null;
  userId: string;
  username: string;
  triggerKind: 'manual' | 'import';
  position: number | null;
  lineCount: number | null;
  status: ReconcileRecipeRunStatus;
  skipReason: string | null;
  conversationId: string | null;
  runId: string | null;
  runStatus: AiRunStatus | null;
  runError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ReconcileRecipeDto = {
  id: string;
  caixaId: string | null;
  caixaName: string | null;
  agentId: string;
  agentName: string;
  /** Sem kit: o agente lança sem pedir aprovação (o formulário avisa). */
  agentHasKit: boolean;
  agentActive: boolean;
  name: string;
  description: string | null;
  instruction: string;
  runOnImport: boolean;
  position: number;
  isActive: boolean;
  archivedAt: string | null;
  targets: ReconcileRecipeTargetDto[];
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun: ReconcileRecipeRunDto | null;
};

/** Receita que vale para o lote: `linked` = vinculada à conta/cartão do lote. */
export type ImportRecipeDto = ReconcileRecipeDto & { linked: boolean };

export type ImportRecipesDto = {
  recipes: ImportRecipeDto[];
  runs: ReconcileRecipeRunDto[];
  /** Linhas pendentes (novas e sugeridas): o escopo do play sem seleção. */
  pendingLines: number;
  /** Há execução ativa de conciliação no lote (o play responde 409). */
  busy: boolean;
  /** Quem vê pode rodar (escreve na caixa do lote). */
  canRun: boolean;
};

export type ReconcileRecipeRunResult = { run: ReconcileRecipeRunDto; runId: string; conversationId: string; lines: number };

/** Motivo de uma execução pulada ou que falhou, para a tela e para as tools. */
export function recipeSkipReasonText(reason: string | null): string {
  switch (reason) {
    case null:
      return '';
    case 'no_lines':
      return 'Pulada: nenhuma linha pendente quando chegou a vez dela.';
    case 'recipe_inactive':
      return 'Pulada: a receita foi desligada ou arquivada.';
    case 'agent_inactive':
      return 'Pulada: o agente está inativo ou arquivado.';
    case 'user_inactive':
      return 'Pulada: quem importou está inativo.';
    case 'budget_exceeded':
      return 'Pulada: orçamento de IA atingido.';
    case 'rate_limited':
      return 'Pulada: limite de execuções por minuto.';
    case 'canceled':
      return 'A execução foi parada.';
    default:
      return reason;
  }
}

/* ---------------- tools (categoria Conciliação) ---------------- */

export const RECIPE_TOOLS = [
  define({
    name: 'list_reconcile_recipes',
    category: 'reconciliation',
    title: 'Listar receitas de conciliação',
    description:
      'Receitas de conciliação visíveis (instrução reutilizável com o agente responsável, dona uma caixa ou global): agente, contas vinculadas, "rodar ao importar", ordem, ativa e a última execução. Filtre por caixa (caixaId ou "global") ou por conta/cartão.',
    kind: 'read',
    input: z.object({
      caixaId: z.union([id, z.literal('global')]).optional(),
      accountId: id.optional(),
      cardCaixaId: id.optional(),
      archived: z.boolean().optional().describe('true = as arquivadas.'),
    }),
  }),
  define({
    name: 'create_reconcile_recipe',
    category: 'reconciliation',
    title: 'Criar receita de conciliação',
    description:
      'Cria uma receita de conciliação: a instrução vai ao agente escolhido, numa sessão nova, sobre as linhas de um lote de extrato (play na tela do lote ou "rodar ao importar"). Variáveis: {{lote.id}}, {{lote.arquivo}}, {{lote.periodo}}, {{conta.nome}}, {{caixa.nome}}, {{caixa.titular}}, {{linhas.total}} e as do prompt ({{data}}, {{usuario.nome}}…). Global (caixaId null) só administrador.',
    kind: 'write',
    input: reconcileRecipeCreateInput,
  }),
  define({
    name: 'update_reconcile_recipe',
    category: 'reconciliation',
    title: 'Editar receita de conciliação',
    description:
      'Altera o agente, o nome, a instrução, as contas vinculadas (a lista substitui a atual), "rodar ao importar", a ordem ou liga/desliga uma receita (a dona não muda).',
    kind: 'write',
    input: z.object({ recipeId: id, changes: reconcileRecipeUpdateInput }),
  }),
  define({
    name: 'archive_reconcile_recipe',
    category: 'reconciliation',
    title: 'Arquivar receita de conciliação',
    description: 'Arquiva (e desliga) uma receita de conciliação; o histórico de execuções fica.',
    kind: 'write',
    destructive: true,
    input: z.object({ recipeId: id }),
  }),
  define({
    name: 'run_reconcile_recipe',
    category: 'reconciliation',
    title: 'Rodar receita de conciliação',
    description:
      'Roda uma receita sobre um lote de extrato (statementImportId), numa sessão nova, nas linhas dadas ou em todas as pendentes. Uma execução de conciliação por lote: com outra ativa, recusa.',
    kind: 'write',
    input: z.object({ recipeId: id, statementImportId: id, lineIds: z.array(id).min(1).max(500).optional() }),
  }),
] as const;
