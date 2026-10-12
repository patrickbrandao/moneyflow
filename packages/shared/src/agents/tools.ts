import { z } from 'zod';
import {
  cardPurchaseInput,
  DIRECTIONS,
  ENTITY_KINDS,
  entityCreateInput,
  entityUpdateInput,
  id,
  isoDate,
  LINE_CREATE_MODES,
  pixKeyInput,
  settlementCreateInput,
  TITLE_FILTERS,
  titleCreateInput,
  titleUpdateInput,
  transferCreateInput,
} from '../schemas';

/*
 * Registro único das tools dos agentes (spec 011): nome, título e descrição em
 * pt-BR, schema Zod de entrada (convertido para JSON Schema para os provedores
 * e para o servidor MCP próprio) e o tipo:
 *  - read: executa direto;
 *  - write: altera dados; pede confirmação ("Aplicar?") conforme o agente
 *    (require_write_confirmation);
 * `confirm: 'always'` força a confirmação mesmo com o agente configurado para
 * não pedir (enviar mensagem ao Telegram); `confirm: 'never'` dispensa (avisar
 * o próprio usuário no sino).
 *
 * A execução fica no servidor (apps/server/src/agents/tool-handlers.ts), com
 * os mesmos serviços e a mesma autorização da API, como o usuário que acionou.
 */

export type AgentToolKind = 'read' | 'write';
export type AgentToolConfirm = 'agent' | 'always' | 'never';

export type AgentToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  kind: AgentToolKind;
  confirm: AgentToolConfirm;
  /** Escrita que apaga/desfaz algo (anotação destructiveHint no MCP). */
  destructive?: boolean;
  input: S;
};

const define = <const N extends string, S extends z.ZodType>(
  def: Omit<AgentToolDef<S>, 'confirm' | 'name'> & { name: N; confirm?: AgentToolConfirm },
): AgentToolDef<S> & { name: N } => ({
  confirm: def.kind === 'read' ? 'never' : 'agent',
  ...def,
});

const date = isoDate.describe('Data no formato AAAA-MM-DD.');
const optionalDate = date.optional();
const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Máximo de itens (padrão ${fallback}).`);
const caixaIds = z.array(id).max(200).optional().describe('Caixas (ids); omitido = todas as que o usuário vê.');

export const AGENT_TOOLS = [
  /* ---------------- leitura ---------------- */
  define({
    name: 'search_records',
    title: 'Buscar registros',
    description:
      'Busca rápida por texto em entidades, caixas e títulos (nome, documento, descrição). Use para descobrir ids antes de outras tools.',
    kind: 'read',
    input: z.object({ query: z.string().trim().min(1).max(200).describe('Texto a buscar.'), limit: limit(30, 10) }),
  }),
  define({
    name: 'semantic_search',
    title: 'Busca por significado',
    description:
      'Busca por significado (embeddings) em entidades, títulos, compras de cartão e linhas de extrato; sem provedor de embeddings, busca por semelhança de texto.',
    kind: 'read',
    input: z.object({
      query: z.string().trim().min(1).max(500),
      types: z
        .array(z.enum(['entity', 'title', 'card_purchase', 'statement_line']))
        .optional()
        .describe('Tipos; omitido = todos.'),
      limit: limit(50, 10),
    }),
  }),
  define({
    name: 'list_caixas',
    title: 'Listar caixas',
    description: 'Lista as caixas (livros financeiros) que o usuário vê, com titular, tipo e saldo.',
    kind: 'read',
    input: z.object({ archived: z.boolean().default(false).describe('true = só as arquivadas.') }),
  }),
  define({
    name: 'get_caixa',
    title: 'Ver caixa',
    description: 'Detalhe de uma caixa: titular, tipo, contas financeiras e configuração de cartão.',
    kind: 'read',
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'list_accounts',
    title: 'Listar contas e saldos',
    description: 'Contas financeiras (corrente, cofre, investimento) de uma caixa com o saldo atual.',
    kind: 'read',
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'get_account_statement',
    title: 'Extrato da conta',
    description: 'Movimentos de uma conta financeira no período, com saldo inicial e final.',
    kind: 'read',
    input: z.object({ accountId: id, from: optionalDate, to: optionalDate }),
  }),
  define({
    name: 'list_entities',
    title: 'Listar entidades',
    description: 'Pessoas e empresas cadastradas (busca por nome ou documento).',
    kind: 'read',
    input: z.object({ q: z.string().trim().max(200).optional(), kind: z.enum(ENTITY_KINDS).optional(), limit: limit(200, 50) }),
  }),
  define({
    name: 'get_entity',
    title: 'Ver entidade',
    description: 'Detalhe de uma entidade: documento, contatos, endereços, dados bancários, chaves PIX e vínculos.',
    kind: 'read',
    input: z.object({ entityId: id }),
  }),
  define({
    name: 'list_categories',
    title: 'Listar categorias',
    description: 'Plano de categorias (receitas e despesas), em árvore.',
    kind: 'read',
    input: z.object({ kind: z.enum(['income', 'expense']).optional() }),
  }),
  define({
    name: 'list_titles',
    title: 'Listar títulos',
    description: 'Títulos a pagar e a receber com filtros (caixa, direção, status, período de vencimento, entidade, texto).',
    kind: 'read',
    input: z.object({
      caixaId: id.optional(),
      direction: z.enum(DIRECTIONS).optional().describe('payable = a pagar; receivable = a receber.'),
      status: z.enum(TITLE_FILTERS).optional(),
      from: optionalDate,
      to: optionalDate,
      q: z.string().trim().max(200).optional(),
      entityId: id.optional(),
      limit: limit(300, 50),
    }),
  }),
  define({
    name: 'get_title',
    title: 'Ver título',
    description: 'Detalhe de um título: valores, baixas, espelho, série/parcelas e anexos.',
    kind: 'read',
    input: z.object({ titleId: id }),
  }),
  define({
    name: 'list_transfers',
    title: 'Listar transferências',
    description: 'Transferências entre contas no período.',
    kind: 'read',
    input: z.object({ caixaId: id.optional(), from: optionalDate, to: optionalDate, limit: limit(300, 50) }),
  }),
  define({
    name: 'get_card',
    title: 'Ver cartão',
    description: 'Resumo de um cartão de crédito (caixa do tipo cartão): limite, faturas abertas e fechadas.',
    kind: 'read',
    input: z.object({ cardId: id.describe('Id da caixa do cartão.') }),
  }),
  define({
    name: 'get_invoice',
    title: 'Ver fatura',
    description: 'Fatura do cartão: itens, total por caixa pagadora, status e pagamentos.',
    kind: 'read',
    input: z.object({ invoiceId: id }),
  }),
  define({
    name: 'list_card_purchases',
    title: 'Listar compras do cartão',
    description: 'Compras, estornos e encargos de um cartão no período.',
    kind: 'read',
    input: z.object({ cardId: id, from: optionalDate, to: optionalDate, q: z.string().trim().max(200).optional(), limit: limit(300, 50) }),
  }),
  define({
    name: 'calendar',
    title: 'Calendário',
    description: 'Vencimentos (títulos e faturas) no período, por dia, com status.',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds }),
  }),
  define({
    name: 'report_categories',
    title: 'Relatório por categoria',
    description: 'Totais por categoria e mês no período (competência ou caixa).',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds, basis: z.enum(['competence', 'cash']).default('competence') }),
  }),
  define({
    name: 'report_entities',
    title: 'Relatório por entidade',
    description: 'Totais pagos e recebidos por entidade no período.',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds, basis: z.enum(['competence', 'cash']).default('competence') }),
  }),
  define({
    name: 'report_projection',
    title: 'Saldo projetado',
    description: 'Saldo projetado das caixas em horizontes de dias (padrão 30, 60 e 90).',
    kind: 'read',
    input: z.object({ caixaIds, horizons: z.array(z.number().int().min(1).max(1100)).min(1).max(6).optional() }),
  }),
  define({
    name: 'flow_graph',
    title: 'Fluxo de dinheiro',
    description: 'Grafo do fluxo de dinheiro entre caixas e entidades no período (nós e arestas com valores).',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds }),
  }),
  define({
    name: 'list_statement_imports',
    title: 'Listar extratos importados',
    description: 'Extratos (OFX/CSV) importados de uma conta ou cartão.',
    kind: 'read',
    input: z.object({ accountId: id.optional(), cardCaixaId: id.optional() }),
  }),
  define({
    name: 'get_statement_import',
    title: 'Ver extrato importado',
    description: 'Linhas de um extrato importado com status de conciliação e classificação sugerida.',
    kind: 'read',
    input: z.object({ importId: id }),
  }),
  define({
    name: 'list_message_destinations',
    title: 'Listar destinos de mensagem',
    description: 'Destinos do Telegram que o usuário pode usar.',
    kind: 'read',
    input: z.object({}),
  }),

  /* ---------------- escrita ---------------- */
  define({
    name: 'create_entity',
    title: 'Criar entidade',
    description: 'Cadastra uma pessoa (CPF) ou empresa (CNPJ). Verifique antes com search_records se já existe.',
    kind: 'write',
    input: entityCreateInput,
  }),
  define({
    name: 'update_entity',
    title: 'Editar entidade',
    description: 'Altera nome, nome fantasia, documento, nascimento ou observações de uma entidade.',
    kind: 'write',
    input: z.object({ entityId: id, changes: entityUpdateInput }),
  }),
  define({
    name: 'add_pix_key',
    title: 'Adicionar chave PIX',
    description: 'Adiciona uma chave PIX (cpf, cnpj, email, phone ou random) a uma entidade.',
    kind: 'write',
    input: z.object({ entityId: id, pixKey: pixKeyInput }),
  }),
  define({
    name: 'create_title',
    title: 'Criar título',
    description:
      'Cria um título a pagar (payable) ou a receber (receivable) numa caixa. Espelho: a caixa principal da entidade recebe o lado oposto (mirrorCaixaId null = sem espelho). Parcelado ou recorrente via series; no parcelado amountCents é o valor de CADA parcela.',
    kind: 'write',
    input: titleCreateInput,
  }),
  define({
    name: 'update_title',
    title: 'Editar título',
    description: 'Altera um título em aberto (entidade, categoria, descrição, datas, valor, observações).',
    kind: 'write',
    input: z.object({ titleId: id, changes: titleUpdateInput }),
  }),
  define({
    name: 'end_series',
    title: 'Encerrar série recorrente',
    description:
      'Encerra (ou estende) a série recorrente de um título numa data: as ocorrências que vencem até endsOn continuam; as seguintes em aberto são canceladas (com o espelho), sem apagar. endsOn null = sem fim (reabre as canceladas por um encerramento anterior). Falha se houver ocorrência com baixa depois da data.',
    kind: 'write',
    destructive: true,
    input: z.object({
      titleId: id.describe('Qualquer ocorrência da série.'),
      endsOn: date.nullable().describe('Último vencimento a manter (AAAA-MM-DD); null = sem fim.'),
    }),
  }),
  define({
    name: 'settle_title',
    title: 'Baixar título',
    description:
      'Registra uma baixa (pagamento ou recebimento, total ou parcial) de um título, numa conta da caixa do título (financialAccountId null = conta a definir).',
    kind: 'write',
    input: z.object({ titleId: id, settlement: settlementCreateInput }),
  }),
  define({
    name: 'create_transfer',
    title: 'Criar transferência',
    description: 'Transfere dinheiro entre duas contas financeiras (inclusive de caixas diferentes).',
    kind: 'write',
    input: transferCreateInput,
  }),
  define({
    name: 'create_card_purchase',
    title: 'Lançar compra no cartão',
    description: 'Lança uma compra no cartão (valor total; parcelas em installmentsTotal), com o recebedor final (entidade) e a categoria.',
    kind: 'write',
    input: z.object({ cardId: id, purchase: cardPurchaseInput }),
  }),
  define({
    name: 'match_statement_line',
    title: 'Conciliar linha do extrato',
    description: 'Casa uma linha do extrato com um movimento, um título em aberto (vira baixa) ou um item de fatura.',
    kind: 'write',
    input: z.object({
      lineId: id,
      movementId: id.optional(),
      titleId: id.optional(),
      cardInvoiceItemId: id.optional(),
    }),
  }),
  define({
    name: 'confirm_statement_lines',
    title: 'Confirmar sugestões de conciliação',
    description: 'Confirma em lote as linhas do extrato com casamento sugerido.',
    kind: 'write',
    input: z.object({ lineIds: z.array(id).min(1).max(500) }),
  }),
  define({
    name: 'create_from_statement_line',
    title: 'Lançar a partir da linha',
    description:
      'Transforma uma linha nova do extrato em lançamento: movimento avulso (adjustment), título já baixado (title) ou compra (purchase).',
    kind: 'write',
    input: z.object({
      lineId: id,
      mode: z.enum(LINE_CREATE_MODES),
      entityId: id.nullish(),
      categoryId: id.nullish(),
      description: z.string().trim().max(300).nullish(),
      learnRule: z.boolean().default(true),
    }),
  }),
  define({
    name: 'classify_statement_lines',
    title: 'Sugerir classificação',
    description:
      'Sugere entidade e categoria para linhas do extrato sem regra; ficam como "sugerido pelo agente", pendentes de aprovação do usuário.',
    kind: 'write',
    input: z.object({
      suggestions: z
        .array(z.object({ lineId: id, entityId: id.nullish(), categoryId: id.nullish() }))
        .min(1)
        .max(500),
    }),
  }),
  define({
    name: 'apply_classification_suggestions',
    title: 'Aprovar sugestões de classificação',
    description: 'Aprova (ou descarta) as sugestões de classificação do agente nas linhas do extrato.',
    kind: 'write',
    input: z.object({ lineIds: z.array(id).min(1).max(500), decision: z.enum(['approve', 'reject']).default('approve') }),
  }),
  define({
    name: 'send_telegram_message',
    title: 'Enviar mensagem',
    description: 'Envia um texto a um destino do Telegram (use list_message_destinations). Sempre pede confirmação.',
    kind: 'write',
    confirm: 'always',
    input: z.object({ destinationId: id, text: z.string().trim().min(1).max(3500) }),
  }),
  define({
    name: 'notify_user',
    title: 'Avisar o usuário',
    description:
      'Avisa o próprio usuário no sino (e nos destinos dele que assinam "mensagens do agente"). Use para resultados de tarefas longas.',
    kind: 'write',
    confirm: 'never',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(2000),
      link: z.string().max(500).optional(),
    }),
  }),
] as const satisfies readonly AgentToolDef[];

export type AgentToolName = (typeof AGENT_TOOLS)[number]['name'];

const BY_NAME = new Map<string, AgentToolDef>(AGENT_TOOLS.map((tool) => [tool.name, tool]));

export function agentTool(name: string): AgentToolDef | undefined {
  return BY_NAME.get(name);
}

export const AGENT_TOOL_NAMES: string[] = AGENT_TOOLS.map((tool) => tool.name);

/** Valor da entrada já validada (com defaults) de uma tool. */
export type AgentToolInput<N extends AgentToolName> = z.output<Extract<(typeof AGENT_TOOLS)[number], { name: N }>['input']>;

/** A chamada precisa de confirmação? */
export function needsConfirmation(tool: Pick<AgentToolDef, 'kind' | 'confirm'>, agentRequiresConfirmation: boolean): boolean {
  if (tool.confirm === 'always') return true;
  if (tool.confirm === 'never') return false;
  return tool.kind === 'write' && agentRequiresConfirmation;
}
