import type { Executor } from '@moneyflow/db';
import {
  type PromptPart,
  type PromptVariableValues,
  renderPromptVariables,
  type ScreenContext,
  scanPromptVariables,
  t,
  todayIso,
  volatilePromptValues,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { Access } from '../authz/access';
import { readableFilter } from '../services/caixas';
import { type FlowPurpose, flowSystemPrompt } from './flows';

/*
 * Montagem do prompt de sistema (spec 022), na ordem fixa:
 *   1. base do sistema; 2. prompt do agente com as variáveis estáveis; 3. instructions dos MCP no modo system;
 *   4. prompt fixo do fluxo — PONTO DE CACHE 1 (junto com as tools);
 *   5. instruções do usuário (nunca nos fluxos); 6. contexto automático — PONTO DE CACHE 2 (estável por usuário);
 *   7. parte volátil: o prompt do agente se ele usa variáveis voláteis, a data, o usuário e a tela.
 * As instructions dos MCP no modo user não vão para o sistema: viram um bloco do papel user no início do histórico
 * enviado, montado na hora e nunca gravado em ai_messages. Nos fluxos não há MCP (nem tools nem instructions).
 */

const MAX_CAIXAS = 60;
const MAX_ACCOUNTS = 300;

export type PrimaryCaixa = { id: string; name: string; holderName: string };

export type PromptInputs = {
  agent: { name: string; system_prompt: string };
  user: { username: string; email: string };
  /** Instruções do usuário (Minha conta → IA); '' = nenhuma. */
  instructions: string;
  primaryCaixa: PrimaryCaixa | null;
  /** Contexto automático já montado (autoContext). */
  context: string;
  mcp: { name: string; mode: 'system' | 'user'; text: string }[];
};

export type AssembledPrompt = {
  /** Até o ponto de cache 1. */
  stable: string;
  /** Do ponto 1 ao ponto 2 (por usuário). */
  user: string;
  /** Depois do ponto 2. */
  volatile: string;
  /** Bloco do papel user com as instructions dos MCP no modo user (null = nenhum). */
  mcpUserBlock: string | null;
  /** O prompt do agente usa variáveis voláteis (foi para a parte volátil). */
  volatileVariables: boolean;
};

const join = (parts: (string | null | undefined)[]) =>
  parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join('\n\n');

/** Monta as três partes do prompt e o bloco user dos MCP (puro: sem banco). */
export function assemblePrompt(
  inputs: PromptInputs,
  opts: { purpose: FlowPurpose | null; screen: Record<string, unknown> | null; today?: string },
): AssembledPrompt {
  const today = opts.today ?? todayIso();
  const stableValues: PromptVariableValues = {
    'agente.nome': inputs.agent.name,
    'usuario.nome': inputs.user.username,
    'usuario.login': inputs.user.username,
    'usuario.email': inputs.user.email,
    'usuario.caixa_principal': inputs.primaryCaixa?.name ?? '',
    'empresa.titular_principal': inputs.primaryCaixa?.holderName ?? '',
  };
  const volatileVariables = scanPromptVariables(inputs.agent.system_prompt).volatile;
  const agentPrompt = renderPromptVariables(
    inputs.agent.system_prompt,
    volatileVariables ? { ...stableValues, ...volatilePromptValues(today) } : stableValues,
  );
  const flow = opts.purpose !== null;
  const mcpSystem = flow
    ? []
    : inputs.mcp.filter((m) => m.mode === 'system').map((m) => `${t.agents.systemPrompt.mcpInstructions(m.name)}\n${m.text.trim()}`);
  const mcpUser = flow
    ? []
    : inputs.mcp.filter((m) => m.mode === 'user').map((m) => `${t.agents.systemPrompt.mcpUserInstructions(m.name)}\n${m.text.trim()}`);

  const stable = join([
    t.agents.systemPrompt.base,
    volatileVariables ? null : agentPrompt,
    ...mcpSystem,
    opts.purpose ? flowSystemPrompt(opts.purpose) : null,
  ]);
  const user = join([
    !flow && inputs.instructions.trim()
      ? `${t.agents.systemPrompt.userInstructions(inputs.user.username)}\n${inputs.instructions.trim()}`
      : null,
    inputs.context,
  ]);
  const volatileLines = [t.agents.systemPrompt.today(volatilePromptValues(today).data!, inputs.user.username)];
  if (opts.screen && Object.keys(opts.screen).length > 0 && !flow) {
    volatileLines.push(`${t.agents.systemPrompt.screen}\n${JSON.stringify(opts.screen as ScreenContext)}`);
  }
  const volatile = join([volatileVariables ? agentPrompt : null, volatileLines.join('\n')]);
  return { stable, user, volatile, mcpUserBlock: mcpUser.length > 0 ? mcpUser.join('\n\n') : null, volatileVariables };
}

/** As partes na ordem, com os pontos de cache marcados ("Ver prompt montado"). */
export function promptParts(prompt: AssembledPrompt): PromptPart[] {
  const parts: PromptPart[] = [
    { kind: 'stable', text: prompt.stable, cacheBreakpoint: true },
    ...(prompt.user ? [{ kind: 'user' as const, text: prompt.user, cacheBreakpoint: true }] : []),
    { kind: 'volatile', text: prompt.volatile, cacheBreakpoint: false },
  ];
  if (prompt.mcpUserBlock) parts.push({ kind: 'mcp_user', text: prompt.mcpUserBlock, cacheBreakpoint: false });
  return parts;
}

/** Instruções e caixa principal do usuário (a caixa só vale se ele ainda a lê e ela não foi arquivada). */
export async function loadUserAiSettings(db: Executor, access: Access) {
  const result = await db.execute<{
    instructions: string;
    primary_caixa_id: string | null;
    caixa_name: string | null;
    holder_name: string | null;
    archived: boolean | null;
  }>(sql`
    SELECT s.instructions, s.primary_caixa_id, c.name AS caixa_name, e.name AS holder_name, c.archived_at IS NOT NULL AS archived
      FROM user_ai_settings s
      LEFT JOIN caixas c ON c.id = s.primary_caixa_id
      LEFT JOIN entities e ON e.id = c.holder_entity_id
     WHERE s.user_id = ${access.actor.id}`);
  const row = result.rows[0];
  const primary =
    row?.primary_caixa_id && row.caixa_name && !row.archived && access.canRead(row.primary_caixa_id)
      ? { id: row.primary_caixa_id, name: row.caixa_name, holderName: row.holder_name ?? '' }
      : null;
  return { instructions: row?.instructions ?? '', primaryCaixa: primary };
}

/**
 * Contexto automático do usuário (spec 022), pelo `Access`: login, e-mail, se é admin, a caixa principal, as caixas
 * que ele lê (tipo, papel, id) com as contas, e os cartões. Até 60 caixas e 300 contas; o excesso é cortado com o
 * aviso "lista parcial: use list_caixas".
 */
export async function autoContext(db: Executor, access: Access, primary: PrimaryCaixa | null): Promise<string> {
  const c = t.agents.systemPrompt.context;
  const caixas = await db.execute<{ id: string; name: string; kind: 'general' | 'credit_card' }>(sql`
    SELECT c.id, c.name, c.kind FROM caixas c
     WHERE ${readableFilter(access)} AND c.archived_at IS NULL
     ORDER BY c.kind = 'credit_card', lower(c.name), c.id
     LIMIT ${MAX_CAIXAS + 1}`);
  const caixasCut = caixas.rows.length > MAX_CAIXAS;
  const listed = caixas.rows.slice(0, MAX_CAIXAS);
  const general = listed.filter((x) => x.kind === 'general');
  const cards = listed.filter((x) => x.kind === 'credit_card');
  const accounts = general.length
    ? await db.execute<{ id: string; caixa_id: string; name: string; kind: string }>(sql`
        SELECT a.id, a.caixa_id, a.name, a.kind FROM financial_accounts a
         WHERE a.caixa_id = ANY(${`{${general.map((x) => x.id).join(',')}}`}::uuid[]) AND a.archived_at IS NULL
         ORDER BY lower(a.name), a.id
         LIMIT ${MAX_ACCOUNTS + 1}`)
    : { rows: [] };
  const accountsCut = accounts.rows.length > MAX_ACCOUNTS;
  const accountRows = accounts.rows.slice(0, MAX_ACCOUNTS);
  const role = (id: string) => c.roles[access.roleIn(id) ?? 'viewer'] ?? 'viewer';

  const lines = [c.title, c.user(access.actor.username, access.actor.email, access.isAdmin)];
  if (primary) lines.push(c.primary(primary.name, primary.holderName, primary.id));
  if (listed.length === 0) lines.push(c.none);
  if (general.length > 0) {
    lines.push(c.caixas);
    for (const caixa of general) {
      lines.push(`- ${caixa.name} [${role(caixa.id)}] ${caixa.id}`);
      for (const account of accountRows.filter((a) => a.caixa_id === caixa.id)) {
        lines.push(`  - ${c.account(account.name, t.caixa.accountKinds[account.kind] ?? account.kind, account.id)}`);
      }
    }
    if (accountsCut) lines.push(`(${c.partial})`);
  }
  if (cards.length > 0) {
    lines.push(c.cards);
    for (const card of cards) lines.push(`- ${card.name} [${role(card.id)}] ${card.id}`);
  }
  if (caixasCut) lines.push(`(${c.partial})`);
  return lines.join('\n');
}

/** As instructions dos MCP efetivos do agente fora do modo ignore (do cache). */
export async function loadMcpInstructions(db: Executor, agentId: string): Promise<PromptInputs['mcp']> {
  const result = await db.execute<{ name: string; instructions_mode: 'system' | 'user'; instructions_cache: string }>(sql`
    SELECT name, instructions_mode, instructions_cache FROM effective_agent_mcp_servers
     WHERE agent_id = ${agentId} AND instructions_mode <> 'ignore' AND coalesce(instructions_cache, '') <> ''
     ORDER BY lower(name), mcp_server_id`);
  return result.rows.map((r) => ({ name: r.name, mode: r.instructions_mode, text: r.instructions_cache }));
}

/** Tudo o que o prompt precisa do banco para um agente e um usuário (no início de cada execução). */
export async function loadPromptInputs(
  db: Executor,
  access: Access,
  agent: { id: string; name: string; system_prompt: string },
  purpose: FlowPurpose | null,
): Promise<PromptInputs> {
  const settings = await loadUserAiSettings(db, access);
  return {
    agent,
    user: { username: access.actor.username, email: access.actor.email },
    instructions: purpose ? '' : settings.instructions,
    primaryCaixa: settings.primaryCaixa,
    context: await autoContext(db, access, settings.primaryCaixa),
    mcp: purpose ? [] : await loadMcpInstructions(db, agent.id),
  };
}
