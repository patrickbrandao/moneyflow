import { isoWeekday, TIME_ZONE, todayIso } from '../dates';

/*
 * Variáveis no prompt do agente (spec 022): `{{nome}}`, com `\{{` para escrever
 * as chaves literalmente. As estáveis dependem do agente e do usuário (ficam no
 * bloco cacheado; o cache fica por usuário); as voláteis mudam a cada dia e
 * levam o prompt inteiro para depois do ponto de cache 2.
 */

export type PromptVariableKind = 'stable' | 'volatile';

export const PROMPT_VARIABLES = [
  { name: 'agente.nome', kind: 'stable', description: 'Nome do agente' },
  { name: 'usuario.nome', kind: 'stable', description: 'Login do usuário (o usuário não tem nome no cadastro)' },
  { name: 'usuario.login', kind: 'stable', description: 'Login do usuário' },
  { name: 'usuario.email', kind: 'stable', description: 'E-mail do usuário' },
  { name: 'usuario.caixa_principal', kind: 'stable', description: 'Caixa escolhida em Minha conta → IA (vazia se não escolheu)' },
  { name: 'empresa.titular_principal', kind: 'stable', description: 'Titular da caixa principal do usuário (vazio se não escolheu)' },
  { name: 'data', kind: 'volatile', description: 'Data de hoje (DD/MM/AAAA, São Paulo)' },
  { name: 'data_iso', kind: 'volatile', description: 'Data de hoje (AAAA-MM-DD)' },
  { name: 'dia_semana', kind: 'volatile', description: 'Dia da semana de hoje' },
  { name: 'mes_ano', kind: 'volatile', description: 'Mês e ano de hoje' },
] as const satisfies readonly { name: string; kind: PromptVariableKind; description: string }[];

export type PromptVariableName = (typeof PROMPT_VARIABLES)[number]['name'];
export type PromptVariableValues = Partial<Record<PromptVariableName, string>>;

const KINDS = new Map<string, PromptVariableKind>(PROMPT_VARIABLES.map((v) => [v.name, v.kind]));

/**
 * Variáveis do lote (spec 030), só na instrução das receitas de conciliação,
 * além das da spec 022. Valem por execução (a instrução renderizada vira a
 * mensagem do usuário, fora do prompt de sistema).
 */
export const RECIPE_PROMPT_VARIABLES = [
  { name: 'lote.id', kind: 'volatile', description: 'Id do lote de extrato' },
  { name: 'lote.arquivo', kind: 'volatile', description: 'Nome do arquivo importado' },
  { name: 'lote.periodo', kind: 'volatile', description: 'Primeira e última data das linhas (DD/MM/AAAA a DD/MM/AAAA)' },
  { name: 'conta.nome', kind: 'volatile', description: 'Conta ou cartão do lote' },
  { name: 'caixa.nome', kind: 'volatile', description: 'Caixa do lote' },
  { name: 'caixa.titular', kind: 'volatile', description: 'Titular da caixa do lote' },
  { name: 'linhas.total', kind: 'volatile', description: 'Linhas no escopo da execução' },
] as const satisfies readonly { name: string; kind: PromptVariableKind; description: string }[];

export type RecipeVariableName = PromptVariableName | (typeof RECIPE_PROMPT_VARIABLES)[number]['name'];
export type RecipeVariableValues = Partial<Record<RecipeVariableName, string>>;

const RECIPE_KINDS = new Map<string, PromptVariableKind>([...KINDS, ...RECIPE_PROMPT_VARIABLES.map((v) => [v.name, v.kind] as const)]);

/** `\{{` (escape) ou `{{ nome }}`; o grupo 1 é o nome. */
const TOKEN = /\\\{\{|\{\{([^{}\n]*)\}\}/g;

export type PromptVariableScan = { used: string[]; unknown: string[]; volatile: boolean };

/** Variáveis usadas no texto (sem repetir), as desconhecidas e se alguma é volátil. */
export function scanPromptVariables(text: string): PromptVariableScan {
  return scanWith(text, KINDS);
}

/** O mesmo da instrução de uma receita (spec 030): as da 022 e as do lote. */
export function scanRecipeVariables(text: string): PromptVariableScan {
  return scanWith(text, RECIPE_KINDS);
}

function scanWith(text: string, kinds: ReadonlyMap<string, PromptVariableKind>): PromptVariableScan {
  const used: string[] = [];
  const unknown: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    if (match[1] === undefined) continue;
    const name = match[1].trim();
    if (kinds.has(name)) {
      if (!used.includes(name)) used.push(name);
    } else if (!unknown.includes(name)) unknown.push(name);
  }
  return { used, unknown, volatile: used.some((name) => kinds.get(name) === 'volatile') };
}

/** Substitui as variáveis (ausente = vazio) e desfaz o escape `\{{`. Desconhecidas ficam como estão. */
export function renderPromptVariables(text: string, values: PromptVariableValues): string {
  return renderWith(text, values, KINDS);
}

/** Renderiza a instrução de uma receita (spec 030). */
export function renderRecipeVariables(text: string, values: RecipeVariableValues): string {
  return renderWith(text, values, RECIPE_KINDS);
}

function renderWith(text: string, values: Record<string, string | undefined>, kinds: ReadonlyMap<string, PromptVariableKind>) {
  return text.replace(TOKEN, (whole, raw: string | undefined) => {
    if (raw === undefined) return '{{';
    const name = raw.trim();
    return kinds.has(name) ? (values[name] ?? '') : whole;
  });
}

const WEEKDAYS = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** Valores das variáveis voláteis para o dia (padrão: hoje em São Paulo). */
export function volatilePromptValues(iso: string = todayIso(new Date(), TIME_ZONE)): PromptVariableValues {
  const [y, m, d] = iso.split('-');
  return {
    data: `${d}/${m}/${y}`,
    data_iso: iso,
    dia_semana: WEEKDAYS[isoWeekday(iso) - 1]!,
    mes_ano: `${MONTHS[Number(m) - 1]} de ${y}`,
  };
}
