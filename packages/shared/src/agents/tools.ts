import { z } from 'zod';
import {
  cardPurchaseInput,
  DIRECTIONS,
  ENTITY_KINDS,
  entityCreateInput,
  entityUpdateInput,
  id,
  LINE_STATUSES,
  lineCreateInput,
  lineUnmatchInput,
  pixKeyInput,
  settlementCreateInput,
  settlementReverseInput,
  TITLE_FILTERS,
  titleCreateInput,
  titleUpdateInput,
  transferCreateInput,
} from '../schemas';
import { RECIPE_TOOLS } from './recipes';
import { type AgentToolDef, type AgentToolMode, date, define, limit, optionalDate } from './tool-def';
import { ADMIN_TOOLS } from './tools-admin';
import { OPERATION_TOOLS } from './tools-operation';

/*
 * Registro único das tools dos agentes (specs 011 e 021): nome, título e
 * descrição em pt-BR, schema Zod de entrada (convertido para JSON Schema para
 * os provedores e para o servidor MCP próprio), o tipo (read = só consulta;
 * write = altera dados), a categoria (blocos da guia "Kit de Ferramentas") e o
 * modo sugerido quando a tool é marcada num kit (leituras e notify_user em
 * allow; as demais escritas em ask).
 *
 * Quem decide se a chamada roda direto (allow) ou pede aprovação (ask) é o kit
 * de ferramentas do agente; agente sem kit = todas em allow. Exceções fixas:
 *  - `secrets`: campos de segredo, digitados pelo usuário no cartão de
 *    aprovação (spec 027) — a tool fica sempre em ask, com ou sem kit;
 *  - `adminOnly`: nunca oferecida ao modelo quando quem aciona não é admin.
 *
 * A execução fica no servidor (apps/server/src/agents/tool-handlers.ts), com
 * os mesmos serviços e a mesma autorização da API, como o usuário que acionou.
 */

export {
  AGENT_TOOL_CATEGORIES,
  AGENT_TOOL_MODES,
  type AgentToolCategory,
  type AgentToolDef,
  type AgentToolKind,
  type AgentToolMode,
} from './tool-def';

const caixaIds = z.array(id).max(200).optional().describe('Caixas (ids); omitido = todas as que o usuário vê.');
const lineIds = z.array(id).min(1).max(500);
/** Filtro de entidades por tags e favoritas (spec 003/014): o mesmo da listagem e dos relatórios. */
const entityFilter = {
  tagIds: z.array(id).max(50).optional().describe('Tags (ids, de list_entity_tags); só as ativas contam.'),
  tagMode: z.enum(['any', 'all']).default('any').describe('any = tem qualquer uma das tags; all = tem todas.'),
  favoritesOnly: z.boolean().default(false).describe('true = só as entidades favoritas.'),
};
/** Alvo do casamento de uma linha: exatamente um dos três. */
const lineMatchItem = z.object({
  lineId: id,
  movementId: id.optional().describe('Movimento já lançado na conta, de mesmo valor.'),
  titleId: id.optional().describe('Título em aberto da caixa da conta: vira baixa com a data e o valor da linha.'),
  cardInvoiceItemId: id.optional().describe('Item de fatura (linhas de fatura de cartão).'),
});
/** Lançamento a partir de uma linha nova (o mesmo corpo de POST /api/statement-lines/:id/create). */
const lineCreateItem = lineCreateInput.extend({ lineId: id });
const LINE_CREATE_HELP =
  'mode: adjustment = movimento avulso; title = título já baixado na conta (espelho como em create_title: a caixa principal da entidade recebe o lado oposto; mirrorCaixaId null = sem espelho); purchase = compra no cartão (linha de fatura; payerCaixaId omitido = pagadora padrão do cartão). Entidade e categoria omitidas = as da classificação da linha.';

export const AGENT_TOOLS = [
  /* ---------------- leitura ---------------- */
  define({
    name: 'search_records',
    category: 'search',
    title: 'Buscar registros',
    description:
      'Busca rápida por texto em entidades, caixas e títulos (nome, documento, descrição). Use para descobrir ids antes de outras tools.',
    kind: 'read',
    input: z.object({ query: z.string().trim().min(1).max(200).describe('Texto a buscar.'), limit: limit(30, 10) }),
  }),
  define({
    name: 'semantic_search',
    category: 'search',
    title: 'Busca por significado',
    description:
      'Busca por significado (embeddings do agente) em entidades, títulos, compras de cartão e linhas de extrato; sem embeddings, busca por semelhança de texto. Com o índice em construção, completa com a semelhança de texto e avisa (notice).',
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
    category: 'caixas',
    title: 'Listar caixas',
    description: 'Lista as caixas (livros financeiros) que o usuário vê, com titular, tipo e saldo.',
    kind: 'read',
    input: z.object({ archived: z.boolean().default(false).describe('true = só as arquivadas.') }),
  }),
  define({
    name: 'get_caixa',
    category: 'caixas',
    title: 'Ver caixa',
    description: 'Detalhe de uma caixa: titular, tipo, contas financeiras e configuração de cartão.',
    kind: 'read',
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'list_accounts',
    category: 'caixas',
    title: 'Listar contas e saldos',
    description: 'Contas financeiras (corrente, cofre, investimento) de uma caixa com o saldo atual.',
    kind: 'read',
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'get_account_statement',
    category: 'caixas',
    title: 'Extrato da conta',
    description: 'Movimentos de uma conta financeira no período, com saldo inicial e final.',
    kind: 'read',
    input: z.object({ accountId: id, from: optionalDate, to: optionalDate }),
  }),
  define({
    name: 'list_entities',
    category: 'entities',
    title: 'Listar entidades',
    description:
      'Pessoas e empresas cadastradas (busca por nome ou documento), com tags e favorita; filtra por tags (any/all) e só favoritas.',
    kind: 'read',
    input: z.object({
      q: z.string().trim().max(200).optional(),
      kind: z.enum(ENTITY_KINDS).optional(),
      ...entityFilter,
      limit: limit(200, 50),
    }),
  }),
  define({
    name: 'list_entity_tags',
    category: 'entities',
    title: 'Listar tags de entidade',
    description: 'Tags ativas do catálogo global de entidades (id, nome, cor e quantas entidades usam cada uma).',
    kind: 'read',
    input: z.object({}),
  }),
  define({
    name: 'get_entity',
    category: 'entities',
    title: 'Ver entidade',
    description: 'Detalhe de uma entidade: documento, contatos, endereços, dados bancários, chaves PIX e vínculos.',
    kind: 'read',
    input: z.object({ entityId: id }),
  }),
  define({
    name: 'list_categories',
    category: 'categories',
    title: 'Listar categorias',
    description: 'Plano de categorias (receitas e despesas), em árvore.',
    kind: 'read',
    input: z.object({ kind: z.enum(['income', 'expense']).optional() }),
  }),
  define({
    name: 'list_titles',
    category: 'titles',
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
    category: 'titles',
    title: 'Ver título',
    description: 'Detalhe de um título: valores, baixas, espelho, série/parcelas e anexos.',
    kind: 'read',
    input: z.object({ titleId: id }),
  }),
  define({
    name: 'list_transfers',
    category: 'caixas',
    title: 'Listar transferências',
    description: 'Transferências entre contas no período.',
    kind: 'read',
    input: z.object({ caixaId: id.optional(), from: optionalDate, to: optionalDate, limit: limit(300, 50) }),
  }),
  define({
    name: 'get_card',
    category: 'cards',
    title: 'Ver cartão',
    description: 'Resumo de um cartão de crédito (caixa do tipo cartão): limite, faturas abertas e fechadas.',
    kind: 'read',
    input: z.object({ cardId: id.describe('Id da caixa do cartão.') }),
  }),
  define({
    name: 'get_invoice',
    category: 'cards',
    title: 'Ver fatura',
    description: 'Fatura do cartão: itens, total por caixa pagadora, status e pagamentos.',
    kind: 'read',
    input: z.object({ invoiceId: id }),
  }),
  define({
    name: 'list_card_purchases',
    category: 'cards',
    title: 'Listar compras do cartão',
    description: 'Compras, estornos e encargos de um cartão no período.',
    kind: 'read',
    input: z.object({ cardId: id, from: optionalDate, to: optionalDate, q: z.string().trim().max(200).optional(), limit: limit(300, 50) }),
  }),
  define({
    name: 'calendar',
    category: 'search',
    title: 'Calendário',
    description: 'Vencimentos (títulos e faturas) no período, por dia, com status.',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds }),
  }),
  define({
    name: 'report_categories',
    category: 'reports',
    title: 'Relatório por categoria',
    description:
      'Totais por categoria e mês no período (competência ou caixa). Com filtro de entidades, só as linhas cuja contraparte casa (sem pagamento de fatura nem linhas sem entidade).',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds, basis: z.enum(['competence', 'cash']).default('competence'), ...entityFilter }),
  }),
  define({
    name: 'report_entities',
    category: 'reports',
    title: 'Relatório por entidade',
    description: 'Totais pagos e recebidos por entidade no período (filtro opcional por tags e favoritas).',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds, basis: z.enum(['competence', 'cash']).default('competence'), ...entityFilter }),
  }),
  define({
    name: 'report_projection',
    category: 'reports',
    title: 'Saldo projetado',
    description:
      'Saldo projetado das caixas em horizontes de dias (padrão 30, 60 e 90). Com filtro de entidades, o saldo de hoje é o da caixa inteira e os lançamentos contam só as entidades filtradas (sem faturas abertas).',
    kind: 'read',
    input: z.object({ caixaIds, horizons: z.array(z.number().int().min(1).max(1100)).min(1).max(6).optional(), ...entityFilter }),
  }),
  define({
    name: 'flow_graph',
    category: 'reports',
    title: 'Fluxo de dinheiro',
    description:
      'Grafo do fluxo de dinheiro entre caixas e entidades no período (nós e arestas com valores). Os nós de entidade trazem tagIds e isFavorite.',
    kind: 'read',
    input: z.object({ from: date, to: date, caixaIds }),
  }),
  define({
    name: 'list_statement_imports',
    category: 'reconciliation',
    title: 'Listar extratos importados',
    description:
      'Lotes de extrato (OFX/CSV) importados de uma conta ou cartão, do mais recente ao mais antigo, em páginas: devolve total, imports e nextOffset (null = acabou; passe-o em offset para a próxima página).',
    kind: 'read',
    input: z.object({
      accountId: id.optional(),
      cardCaixaId: id.optional(),
      limit: limit(50, 20),
      offset: z.number().int().min(0).default(0).describe('Quantos lotes pular (o nextOffset da página anterior).'),
    }),
  }),
  define({
    name: 'get_statement_import',
    category: 'reconciliation',
    title: 'Ver extrato importado',
    description:
      'Um lote de extrato: o resumo (período, saldos, divergência, contagem por situação) e uma página das linhas, com a situação da conciliação, o par, a classificação e createdEntry (o lançamento que nasceu da linha). Filtre por statuses (ex.: ["new", "suggested"] = só as pendentes); lineTotal conta as linhas do filtro e nextOffset (null = acabou) leva à próxima página. limit 0 = só o resumo.',
    kind: 'read',
    input: z.object({
      importId: id,
      statuses: z.array(z.enum(LINE_STATUSES)).max(4).optional().describe('Situações das linhas; omitido = todas.'),
      limit: z.number().int().min(0).max(100).default(50).describe('Linhas por página (até 100; 0 = só o resumo).'),
      offset: z.number().int().min(0).default(0).describe('Quantas linhas pular (o nextOffset da página anterior).'),
    }),
  }),
  define({
    name: 'list_line_candidates',
    category: 'reconciliation',
    title: 'Candidatos da linha do extrato',
    description:
      'Candidatos para casar uma linha do extrato (movimentos, títulos em aberto e itens de fatura próximos em data e valor), do mais provável ao menos.',
    kind: 'read',
    input: z.object({ lineId: id }),
  }),
  define({
    name: 'list_message_destinations',
    category: 'messages',
    title: 'Listar destinos de mensagem',
    description: 'Destinos do Telegram que o usuário pode usar.',
    kind: 'read',
    input: z.object({}),
  }),

  /* ---------------- escrita ---------------- */
  define({
    name: 'create_entity',
    category: 'entities',
    title: 'Criar entidade',
    description:
      'Cadastra uma pessoa (CPF) ou empresa (CNPJ), com tags (tagIds) e favorita opcionais. Verifique antes com search_records se já existe.',
    kind: 'write',
    input: entityCreateInput,
  }),
  define({
    name: 'update_entity',
    category: 'entities',
    title: 'Editar entidade',
    description:
      'Altera nome, nome fantasia, documento, nascimento, observações, tags (tagIds substitui o conjunto) ou favorita de uma entidade.',
    kind: 'write',
    input: z.object({ entityId: id, changes: entityUpdateInput }),
  }),
  define({
    name: 'set_entity_tags',
    category: 'entities',
    title: 'Definir tags da entidade',
    description:
      'Substitui o conjunto de tags de uma entidade (tagIds de list_entity_tags; só tags ativas; lista vazia remove todas). Criar, editar e arquivar tags: create_entity_tag, update_entity_tag e archive_entity_tag (só administrador).',
    kind: 'write',
    input: z.object({ entityId: id, tagIds: z.array(id).max(200) }),
  }),
  define({
    name: 'set_entity_favorite',
    category: 'entities',
    title: 'Marcar entidade como favorita',
    description: 'Marca (favorite true) ou desmarca (false) uma entidade como favorita. A marca é global, igual para todos.',
    kind: 'write',
    input: z.object({ entityId: id, favorite: z.boolean() }),
  }),
  define({
    name: 'add_pix_key',
    category: 'entities',
    title: 'Adicionar chave PIX',
    description: 'Adiciona uma chave PIX (cpf, cnpj, email, phone ou random) a uma entidade.',
    kind: 'write',
    input: z.object({ entityId: id, pixKey: pixKeyInput }),
  }),
  define({
    name: 'create_title',
    category: 'titles',
    title: 'Criar título',
    description:
      'Cria um título a pagar (payable) ou a receber (receivable) numa caixa. Espelho: a caixa principal da entidade recebe o lado oposto (mirrorCaixaId null = sem espelho). Parcelado ou recorrente via series; no parcelado amountCents é o valor de CADA parcela.',
    kind: 'write',
    input: titleCreateInput,
  }),
  define({
    name: 'update_title',
    category: 'titles',
    title: 'Editar título',
    description: 'Altera um título em aberto (entidade, categoria, descrição, datas, valor, observações).',
    kind: 'write',
    input: z.object({ titleId: id, changes: titleUpdateInput }),
  }),
  define({
    name: 'end_series',
    category: 'titles',
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
    category: 'titles',
    title: 'Baixar título',
    description:
      'Registra uma baixa (pagamento ou recebimento, total ou parcial) de um título, numa conta da caixa do título (financialAccountId null = conta a definir).',
    kind: 'write',
    input: z.object({ titleId: id, settlement: settlementCreateInput }),
  }),
  define({
    name: 'reverse_settlement',
    category: 'titles',
    title: 'Estornar baixa',
    description:
      'Estorna uma baixa (get_title lista as baixas do título, com o id): a baixa e a perna do espelho ficam estornadas, cada perna com conta recebe o movimento oposto e o título volta a ter o valor em aberto. Use para corrigir uma baixa errada, inclusive a criada ao casar uma linha do extrato com o título errado (desfaça antes a conciliação com unmatch_statement_line).',
    kind: 'write',
    destructive: true,
    input: z.object({
      settlementId: id.describe('Baixa a estornar.'),
      reason: settlementReverseInput.shape.reason.describe('Motivo do estorno (fica na baixa).'),
      reversedOn: settlementReverseInput.shape.reversedOn.describe(
        'Data do estorno (AAAA-MM-DD); omitida = hoje. Não pode ser antes da baixa.',
      ),
      undoTransfer: settlementReverseInput.shape.undoTransfer.describe(
        'Baixa paga com conta de outra caixa: true (padrão) desfaz a transferência gerada.',
      ),
    }),
  }),
  define({
    name: 'create_transfer',
    category: 'caixas',
    title: 'Criar transferência',
    description: 'Transfere dinheiro entre duas contas financeiras (inclusive de caixas diferentes).',
    kind: 'write',
    input: transferCreateInput,
  }),
  define({
    name: 'create_card_purchase',
    category: 'cards',
    title: 'Lançar compra no cartão',
    description: 'Lança uma compra no cartão (valor total; parcelas em installmentsTotal), com o recebedor final (entidade) e a categoria.',
    kind: 'write',
    input: z.object({ cardId: id, purchase: cardPurchaseInput }),
  }),
  define({
    name: 'match_statement_line',
    category: 'reconciliation',
    title: 'Conciliar linha do extrato',
    description:
      'Casa uma linha do extrato com um movimento, um título em aberto (vira baixa) ou um item de fatura. Para várias linhas, use match_statement_lines.',
    kind: 'write',
    input: lineMatchItem,
  }),
  define({
    name: 'match_statement_lines',
    category: 'reconciliation',
    title: 'Conciliar linhas do extrato em lote',
    description:
      'Casa até 500 linhas do extrato, cada uma com um movimento, um título em aberto (vira baixa) ou um item de fatura (use list_line_candidates). Cada linha é independente: as que falham voltam em failed com o motivo.',
    kind: 'write',
    input: z.object({ matches: z.array(lineMatchItem).min(1).max(500) }),
  }),
  define({
    name: 'confirm_statement_lines',
    category: 'reconciliation',
    title: 'Confirmar sugestões de conciliação',
    description: 'Confirma em lote as linhas do extrato com casamento sugerido.',
    kind: 'write',
    input: z.object({ lineIds }),
  }),
  define({
    name: 'unmatch_statement_line',
    category: 'reconciliation',
    title: 'Desfazer conciliação da linha',
    description:
      'Desfaz a conciliação (ou a sugestão) de uma linha do extrato, que volta a nova. Por padrão o lançamento conciliado continua lançado. Se ele nasceu da linha (createdEntry em get_statement_import: adjustment = avulso, title = título já baixado, settlement = baixa num título existente, purchase = compra no cartão), deleteEntry true o exclui junto (o título criado com o espelho e a baixa; a baixa num título existente, que volta a ter o valor em aberto) — use antes de relançar a linha, para não duplicar o valor.',
    kind: 'write',
    destructive: true,
    input: z.object({
      lineId: id,
      deleteEntry: lineUnmatchInput.shape.deleteEntry.describe(
        'true = exclui também o lançamento que nasceu da linha (só quando createdEntry não é nulo).',
      ),
    }),
  }),
  define({
    name: 'ignore_statement_lines',
    category: 'reconciliation',
    title: 'Ignorar linhas do extrato',
    description: 'Marca linhas do extrato (não conciliadas) como ignoradas: ficam fora da conciliação.',
    kind: 'write',
    input: z.object({ lineIds }),
  }),
  define({
    name: 'unignore_statement_lines',
    category: 'reconciliation',
    title: 'Voltar linhas ignoradas',
    description: 'Linhas ignoradas do extrato voltam a novas.',
    kind: 'write',
    input: z.object({ lineIds }),
  }),
  define({
    name: 'create_from_statement_line',
    category: 'reconciliation',
    title: 'Lançar a partir da linha',
    description: `Transforma uma linha nova do extrato em lançamento conciliado com ela. ${LINE_CREATE_HELP}`,
    kind: 'write',
    input: lineCreateItem,
  }),
  define({
    name: 'create_from_statement_lines',
    category: 'reconciliation',
    title: 'Lançar linhas do extrato em lote',
    description: `Transforma até 500 linhas novas do extrato em lançamentos conciliados. Cada linha é independente: as que falham voltam em failed com o motivo. ${LINE_CREATE_HELP}`,
    kind: 'write',
    input: z.object({ items: z.array(lineCreateItem).min(1).max(500) }),
  }),
  define({
    name: 'classify_statement_lines',
    category: 'reconciliation',
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
    category: 'reconciliation',
    title: 'Aprovar sugestões de classificação',
    description: 'Aprova (ou descarta) as sugestões de classificação do agente nas linhas do extrato.',
    kind: 'write',
    input: z.object({ lineIds, decision: z.enum(['approve', 'reject']).default('approve') }),
  }),
  define({
    name: 'send_telegram_message',
    category: 'messages',
    title: 'Enviar mensagem',
    description: 'Envia um texto a um destino do Telegram (use list_message_destinations).',
    kind: 'write',
    input: z.object({ destinationId: id, text: z.string().trim().min(1).max(3500) }),
  }),
  define({
    name: 'notify_user',
    category: 'messages',
    title: 'Avisar o usuário',
    description:
      'Avisa o próprio usuário no sino (e nos destinos dele que assinam "mensagens do agente"). Use para resultados de tarefas longas.',
    kind: 'write',
    suggestedMode: 'allow',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(2000),
      link: z.string().max(500).optional(),
    }),
  }),

  /* ---------------- controle total, lotes F13a e F13b (spec 027) ---------------- */
  ...OPERATION_TOOLS,
  ...ADMIN_TOOLS,
  /* ---------------- receitas de conciliação (spec 030) ---------------- */
  ...RECIPE_TOOLS,
] as const satisfies readonly AgentToolDef[];

export type AgentToolName = (typeof AGENT_TOOLS)[number]['name'];

const BY_NAME = new Map<string, AgentToolDef>(AGENT_TOOLS.map((tool) => [tool.name, tool]));

export function agentTool(name: string): AgentToolDef | undefined {
  return BY_NAME.get(name);
}

export const AGENT_TOOL_NAMES: string[] = AGENT_TOOLS.map((tool) => tool.name);

/** Valor da entrada já validada (com defaults) de uma tool. */
export type AgentToolInput<N extends AgentToolName> = z.output<Extract<(typeof AGENT_TOOLS)[number], { name: N }>['input']>;

/** Modo efetivo de uma tool oferecida: as de segredo sempre ask; sem kit (`kitMode` null) = allow. */
export function effectiveToolMode(tool: Pick<AgentToolDef, 'secrets'>, kitMode: AgentToolMode | null): AgentToolMode {
  if (tool.secrets && tool.secrets.length > 0) return 'ask';
  return kitMode ?? 'allow';
}

/**
 * Tools internas oferecidas ao modelo, com o modo de cada uma (spec 021):
 * sem kit (`kit` null), todas; com kit, só as dele (tool fora do kit não
 * existe para o agente). As só de administrador saem quando quem aciona não é
 * admin. `registry` = AGENT_TOOLS (o servidor acrescenta as registradas nos testes).
 */
export function kitTools<T extends Pick<AgentToolDef, 'name' | 'secrets' | 'adminOnly'>>(
  registry: readonly T[],
  kit: ReadonlyMap<string, AgentToolMode> | null,
  isAdmin: boolean,
): { tool: T; mode: AgentToolMode }[] {
  const offered: { tool: T; mode: AgentToolMode }[] = [];
  for (const tool of registry) {
    if (tool.adminOnly && !isAdmin) continue;
    if (kit && !kit.has(tool.name)) continue;
    offered.push({ tool, mode: effectiveToolMode(tool, kit ? kit.get(tool.name)! : null) });
  }
  return offered;
}

/**
 * Tools do servidor /mcp próprio (specs 021 e 027): o kit não vale lá, mas as
 * só de administrador saem para quem não é admin, e as de segredo (não há
 * cartão para digitá-lo) e as que geram arquivo (não há sessão para anexá-lo)
 * nunca são expostas.
 */
export function mcpExposed(tool: Pick<AgentToolDef, 'adminOnly' | 'secrets' | 'producesFile'>, isAdmin: boolean): boolean {
  if (tool.adminOnly && !isAdmin) return false;
  if (tool.secrets && tool.secrets.length > 0) return false;
  return !tool.producesFile;
}
