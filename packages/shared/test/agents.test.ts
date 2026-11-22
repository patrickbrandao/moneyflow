import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOOLS,
  AGENT_TOOL_CATEGORIES,
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  type AgentToolMode,
  agentTool,
  aiAgentCreateInput,
  aiAgentUpdateInput,
  balanceToolUses,
  blocksText,
  compactToolResults,
  diffRows,
  effectiveToolMode,
  fitResult,
  formatSse,
  isValidBlock,
  kitTools,
  MAX_RESULT_CHARS,
  MCP_ONLY_TOOLS,
  mcpExposed,
  type NeutralMessage,
  OPERATION_TOOLS,
  previewText,
  SseParser,
  t,
  toolJsonSchema,
  toolKitCreateInput,
  uploadMime,
} from '../src';

describe('registro de tools', () => {
  it('nomes únicos, válidos para Anthropic/OpenAI e descrições em pt-BR', () => {
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOLS.length);
    for (const tool of AGENT_TOOLS) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(['read', 'write']).toContain(tool.kind);
    }
    expect(AGENT_TOOLS.filter((t) => t.kind === 'read').length).toBeGreaterThan(15);
    expect(AGENT_TOOLS.filter((t) => t.kind === 'write').length).toBeGreaterThan(10);
  });

  it('categorias e modo sugerido (spec 021): toda tool numa categoria com nome; leituras, notify_user e refresh_mcp_tools allow, demais escritas ask', () => {
    const allowWrites = ['notify_user', 'refresh_mcp_tools'];
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_TOOL_CATEGORIES).toContain(tool.category);
      expect(tool.suggestedMode).toBe(tool.kind === 'read' || allowWrites.includes(tool.name) ? 'allow' : 'ask');
    }
    for (const category of AGENT_TOOL_CATEGORIES) {
      expect(t.agents.toolCategories[category]).toBeTruthy();
      expect(AGENT_TOOLS.some((tool) => tool.category === category)).toBe(true);
    }
    // 13 da conciliação, as 5 das receitas (spec 030), as 3 do lote provisório (spec 031) e a cobrança esperada da fatura (spec 034).
    expect(AGENT_TOOLS.filter((tool) => tool.category === 'reconciliation')).toHaveLength(22);
    expect(agentTool('send_telegram_message')).toMatchObject({ category: 'messages', suggestedMode: 'ask' });
  });

  it('a tabela de categorias da spec 021 lista exatamente as tools do registro, cada uma na sua categoria (tarefa 158)', () => {
    const spec = readFileSync(join(import.meta.dirname, '../../../docs/021-kit-de-ferramentas.md'), 'utf8');
    const labels = new Map(AGENT_TOOL_CATEGORIES.map((c) => [t.agents.toolCategories[c], c]));
    const inTable = new Map<string, string>();
    for (const line of spec.split('\n')) {
      const cells = /^\| ([^|]+) \| (.+) \|$/.exec(line);
      const category = cells && labels.get(cells[1]!.trim());
      if (!category) continue;
      for (const [, name] of cells[2]!.matchAll(/`([a-z0-9_]+)`/g)) inTable.set(name!, category);
    }
    expect([...inTable.keys()].sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    for (const tool of AGENT_TOOLS) expect(inTable.get(tool.name), tool.name).toBe(tool.category);
  });

  it('as tools que chamam serviço externo ou gastam IA têm a marca external (openWorldHint no /mcp, tarefa 157)', () => {
    expect(
      AGENT_TOOLS.filter((tool) => tool.external)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      [
        'archive_message_destination',
        'convert_contract_pdf',
        'create_entity_from_cnpj',
        'list_provider_models',
        'lookup_cnpj',
        'notify_user',
        'read_document',
        'refresh_mcp_tools',
        'run_agent_task_now',
        'run_reconcile_recipe',
        'semantic_search',
        'send_telegram_message',
        'send_test_message',
        'test_provider',
      ].sort(),
    );
  });

  it('kit: sem kit tudo allow; com kit só as dele no modo do kit; segredo sempre ask; adminOnly fora para não admin', () => {
    const registry = [
      { name: 'ler', secrets: undefined, adminOnly: undefined },
      { name: 'escrever', secrets: undefined, adminOnly: undefined },
      { name: 'segredo', secrets: ['token'] as const, adminOnly: undefined },
      { name: 'admin', secrets: undefined, adminOnly: true },
    ];
    const names = (list: { tool: { name: string }; mode: AgentToolMode }[]) => list.map((x) => `${x.tool.name}:${x.mode}`);
    expect(names(kitTools(registry, null, true))).toEqual(['ler:allow', 'escrever:allow', 'segredo:ask', 'admin:allow']);
    expect(names(kitTools(registry, null, false))).toEqual(['ler:allow', 'escrever:allow', 'segredo:ask']);
    const kit = new Map<string, AgentToolMode>([
      ['ler', 'ask'],
      ['segredo', 'allow'],
      ['admin', 'allow'],
    ]);
    expect(names(kitTools(registry, kit, true))).toEqual(['ler:ask', 'segredo:ask', 'admin:allow']);
    expect(names(kitTools(registry, kit, false))).toEqual(['ler:ask', 'segredo:ask']);
    expect(names(kitTools(registry, new Map(), true))).toEqual([]);
    expect(effectiveToolMode(agentTool('create_title')!, null)).toBe('allow');
    expect(effectiveToolMode(agentTool('list_caixas')!, 'ask')).toBe('ask');
  });

  it('lote F13a (spec 027): categorias novas, destrutivas, só de admin e o /mcp sem segredo nem arquivo gerado', () => {
    const names = (list: readonly { name: string }[]) => list.map((tool) => tool.name).sort();
    expect(OPERATION_TOOLS.every((tool) => AGENT_TOOLS.some((x) => x.name === tool.name))).toBe(true);
    expect(names(AGENT_TOOLS.filter((tool) => tool.category === 'contracts'))).toEqual(
      [
        'list_contracts',
        'get_contract',
        'create_contract',
        'update_contract',
        'activate_contract',
        'add_contract_obligation',
        'link_series_to_contract',
        'add_contract_amendment',
        'terminate_contract',
        'renew_contract',
        'get_contract_document',
        'save_contract_markdown',
        'convert_contract_pdf',
      ].sort(),
    );
    expect(names(AGENT_TOOLS.filter((tool) => tool.category === 'imports'))).toEqual(
      ['import_statement', 'set_statement_import_balance', 'import_nfe', 'read_document', 'parse_payment_code', 'attach_file'].sort(),
    );
    // Só do /mcp (spec 027): o upload de arquivo fica fora do registro, dos kits e das execuções.
    expect(names(MCP_ONLY_TOOLS)).toEqual(['upload_file']);
    expect(agentTool('upload_file')).toBeUndefined();
    expect(uploadMime('extrato.OFX')).toBe('application/x-ofx');
    expect(uploadMime('arquivo.bin')).toBe('application/octet-stream');
    expect(uploadMime('nota.xml', 'text/xml')).toBe('text/xml');
    const balance = agentTool('set_statement_import_balance')!.input;
    const importId = '0192d8e4-0000-7000-8000-000000000002';
    expect(balance.parse({ importId, mode: 'set', bankBalanceCents: -1, bankBalanceOn: '2019-07-31' })).toMatchObject({ mode: 'set' });
    expect(() => balance.parse({ importId, mode: 'set', bankBalanceCents: 100 })).toThrow();
    expect(() => balance.parse({ importId, mode: 'clear', bankBalanceCents: 100, bankBalanceOn: '2019-07-31' })).toThrow();
    expect(balance.parse({ importId, mode: 'file' })).toMatchObject({ mode: 'file' });
    // Aplicar regras (tarefa 152): exatamente um alvo, o lote, a conta ou o cartão.
    const apply = agentTool('apply_classification_rules')!.input;
    expect(apply.parse({ importId })).toEqual({ importId });
    expect(() => apply.parse({})).toThrow();
    expect(() => apply.parse({ importId, accountId: importId })).toThrow();
    expect(names(AGENT_TOOLS.filter((tool) => tool.category === 'categories'))).toEqual(
      [
        'list_categories',
        'create_category',
        'update_category',
        'archive_category',
        'list_classification_rules',
        'create_classification_rule',
        'copy_classification_rules',
        'apply_classification_rules',
        'update_classification_rule',
        'archive_classification_rule',
      ].sort(),
    );
    expect(names(OPERATION_TOOLS.filter((tool) => 'adminOnly' in tool && tool.adminOnly))).toEqual(
      ['archive_caixa', 'create_category', 'update_category', 'archive_category'].sort(),
    );
    expect(names(OPERATION_TOOLS.filter((tool) => 'destructive' in tool && tool.destructive))).toEqual(
      [
        'terminate_contract',
        'reopen_invoice',
        'archive_caixa',
        'archive_account',
        'delete_adjustment',
        'delete_title',
        'delete_transfer',
        'archive_category',
      ].sort(),
    );
    // Contrato pelo agente (spec 034): com as obrigações (vigente) ou rascunho sem elas.
    expect(Object.keys(toolJsonSchema(agentTool('create_contract')!).properties as object)).toEqual(
      expect.arrayContaining(['obligations', 'startsOn', 'endsOn', 'activate']),
    );
    expect(Object.keys(toolJsonSchema(agentTool('create_contract')!).properties as object)).not.toContain('durationMonths');
    // Importação: exatamente um alvo, e o mapeamento salvo ou informado (não os dois).
    const importInput = agentTool('import_statement')!.input;
    const attachmentId = '0192d8e4-0000-7000-8000-000000000001';
    expect(() => importInput.parse({ attachmentId })).toThrow();
    expect(importInput.parse({ attachmentId, accountId: attachmentId })).toMatchObject({ accountId: attachmentId });
    // A decisão da renovação saiu com os contratos sobre séries (F20): renovar é renew_contract (tarefa 158).
    expect(agentTool('decide_contract_renewal')).toBeUndefined();
    expect(agentTool('renew_contract')).toMatchObject({ category: 'contracts', kind: 'write' });
    // /mcp: só admin vê as de admin; segredo e arquivo gerado nunca.
    expect(mcpExposed({ adminOnly: true }, false)).toBe(false);
    expect(mcpExposed({ adminOnly: true }, true)).toBe(true);
    expect(mcpExposed({ secrets: ['apiKey'] }, true)).toBe(false);
    expect(mcpExposed({ producesFile: true }, true)).toBe(false);
    expect(mcpExposed(agentTool('import_statement')!, false)).toBe(true);
  });

  it('lote F13b (spec 027): administração, segredos fora do schema, arquivo gerado e destrutivas', () => {
    const names = (list: readonly { name: string }[]) => list.map((tool) => tool.name).sort();
    expect(ADMIN_TOOLS.every((tool) => AGENT_TOOLS.some((x) => x.name === tool.name))).toBe(true);
    expect(names(AGENT_TOOLS.filter((tool) => 'secrets' in tool && tool.secrets?.length))).toEqual(
      [
        'create_message_destination',
        'update_message_destination',
        'create_user',
        'set_user_password',
        'create_ai_provider',
        'update_ai_provider',
        'create_mcp_server',
        'update_mcp_server',
      ].sort(),
    );
    // O segredo não está no schema que vai ao modelo.
    const props = (name: string) => toolJsonSchema(agentTool(name)!).properties as Record<string, any>;
    expect(Object.keys(props('create_ai_provider'))).not.toContain('apiKey');
    expect(Object.keys(props('update_ai_provider').changes.properties)).not.toContain('apiKey');
    expect(Object.keys(props('update_ai_provider').changes.properties)).toContain('clearApiKey');
    expect(Object.keys(props('create_message_destination'))).not.toContain('botToken');
    expect(Object.keys(props('update_message_destination').changes.properties)).not.toContain('botToken');
    expect(Object.keys(props('create_user'))).not.toContain('password');
    expect(Object.keys(props('set_user_password'))).toEqual(['userId']);
    expect(Object.keys(props('create_mcp_server'))).not.toContain('headers');
    expect(Object.keys(props('update_mcp_server').changes.properties)).not.toContain('setHeaders');
    // Segredo: sempre ask e fora do /mcp; arquivo gerado: fora do /mcp.
    for (const name of ['create_ai_provider', 'set_user_password', 'create_mcp_server']) {
      expect(effectiveToolMode(agentTool(name)!, 'allow')).toBe('ask');
      expect(mcpExposed(agentTool(name)!, true)).toBe(false);
    }
    expect(names(AGENT_TOOLS.filter((tool) => 'producesFile' in tool && tool.producesFile))).toEqual(['export_backup']);
    expect(mcpExposed(agentTool('export_backup')!, true)).toBe(false);
    expect(mcpExposed(agentTool('import_backup')!, true)).toBe(true);
    expect(mcpExposed(agentTool('import_backup')!, false)).toBe(false);
    // close_month é de quem edita a caixa (não destrutivo); reabrir é de admin e destrutivo.
    expect(agentTool('close_month')).toMatchObject({ category: 'closing', kind: 'write' });
    expect(agentTool('close_month')!.adminOnly).toBeUndefined();
    expect(agentTool('close_month')!.destructive).toBeUndefined();
    expect(agentTool('reopen_month')).toMatchObject({ adminOnly: true, destructive: true });
    // Tokens pessoais: do próprio usuário (sem ser admin); criar token não existe.
    expect(agentTool('list_api_tokens')!.adminOnly).toBeUndefined();
    expect(agentTool('revoke_api_token')).toMatchObject({ destructive: true });
    expect(agentTool('create_api_token')).toBeUndefined();
    // Restaurar o dump não é tool.
    expect(AGENT_TOOLS.some((tool) => /dump/.test(tool.name))).toBe(false);
    // Orçamentos (F14, spec 028): Configuração de IA, só admin.
    for (const name of ['list_ai_budgets', 'create_ai_budget', 'update_ai_budget', 'delete_ai_budget'])
      expect(agentTool(name), name).toMatchObject({ category: 'ai', adminOnly: true });
    expect(agentTool('list_ai_budgets')).toMatchObject({ kind: 'read', suggestedMode: 'allow' });
    expect(agentTool('create_ai_budget')).toMatchObject({ kind: 'write', suggestedMode: 'ask' });
    expect(names(ADMIN_TOOLS.filter((tool) => 'destructive' in tool && tool.destructive))).toEqual(
      [
        'archive_entity_tag',
        'archive_message_destination',
        'reopen_month',
        'remove_caixa_member',
        'revoke_api_token',
        'archive_ai_provider',
        'delete_ai_price',
        'archive_ai_agent',
        'delete_tool_kit',
        'archive_mcp_server',
        'delete_ai_budget',
        'delete_agent_task',
        'import_backup',
      ].sort(),
    );
    // Tarefas agendadas (F15, spec 029): Configuração de IA, de qualquer usuário (as próprias; o admin, as de todos).
    for (const name of ['list_agent_tasks', 'create_agent_task', 'update_agent_task', 'delete_agent_task', 'run_agent_task_now'])
      expect(agentTool(name)!.adminOnly, name).toBeUndefined();
    expect(agentTool('list_agent_tasks')).toMatchObject({ category: 'ai', kind: 'read', suggestedMode: 'allow' });
    expect(agentTool('run_agent_task_now')).toMatchObject({ category: 'ai', kind: 'write', suggestedMode: 'ask' });
  });

  it('a entrada valida com o mesmo schema da API (defaults e transforms)', () => {
    const parsed = agentTool('create_entity')!.input.parse({ kind: 'company', name: '  ACME  ', document: '11.222.333/0001-81' });
    expect(parsed).toMatchObject({ name: 'ACME', document: '11222333000181' });
    expect(() => agentTool('create_entity')!.input.parse({ kind: 'person', name: 'X', document: '123' })).toThrow();
    expect(agentTool('list_titles')!.input.parse({})).toMatchObject({ limit: 50 });
  });
});

describe('conversão Zod → JSON Schema', () => {
  it('todas as tools viram objeto, sem $schema e sem o padrão gigante do uuid', () => {
    for (const tool of AGENT_TOOLS) {
      const schema = toolJsonSchema(tool);
      expect(schema.type).toBe('object');
      expect(schema.$schema).toBeUndefined();
      expect(JSON.stringify(schema)).not.toContain('ffffffff-ffff');
    }
  });

  it('descreve centavos, datas e ids', () => {
    const schema = toolJsonSchema(agentTool('create_title')!) as {
      properties: Record<string, { description?: string; format?: string }>;
      required: string[];
    };
    expect(schema.properties.amountCents!.description).toMatch(/centavos/);
    expect(schema.properties.dueDate!.description).toMatch(/AAAA-MM-DD/);
    expect(schema.properties.caixaId!.format).toBe('uuid');
    expect(schema.required).toEqual(expect.arrayContaining(['caixaId', 'direction', 'amountCents']));
  });

  it('todo *Cents diz "centavos" e toda data diz o formato, inclusive os anuláveis (tarefa 154)', () => {
    type Node = Record<string, unknown>;
    const missing: string[] = [];
    const walk = (node: unknown, path: string, key?: string) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Node;
      const description = String(n.description ?? '');
      if (key && /Cents$/.test(key) && !/centavos/.test(description)) missing.push(path);
      if (key && /(Date|On)$|^(from|to)$/.test(key) && !/AAAA-MM/.test(description)) missing.push(path);
      for (const [k, v] of Object.entries(n)) {
        if (k === 'properties' && v && typeof v === 'object') {
          for (const [prop, schema] of Object.entries(v as Node)) walk(schema, `${path}.${prop}`, prop);
        } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf') {
          for (const item of Array.isArray(v) ? v : [v]) walk(item, `${path}[${k}]`);
        }
      }
    };
    for (const tool of AGENT_TOOLS) walk(toolJsonSchema(tool), tool.name);
    expect(missing).toEqual([]);
    const amendment = toolJsonSchema(agentTool('add_contract_amendment')!) as {
      properties: { amendment: { properties: { amountCents: { description?: string } } } };
    };
    expect(amendment.properties.amendment.properties.amountCents.description).toMatch(/centavos/);
    const balance = toolJsonSchema(agentTool('set_statement_import_balance')!) as {
      properties: { bankBalanceOn: { description: string } };
    };
    expect(balance.properties.bankBalanceOn.description).toMatch(/^Data do saldo.*AAAA-MM-DD/);
  });
});

describe('blocos neutros', () => {
  it('valida os blocos por papel (como o banco)', () => {
    expect(isValidBlock('user', { type: 'text', text: 'oi' })).toBe(true);
    expect(isValidBlock('user', { type: 'tool_use', id: 'a', name: 'x', input: {} })).toBe(false);
    expect(isValidBlock('assistant', { type: 'tool_use', id: 'a', name: 'x', input: {} })).toBe(true);
    expect(isValidBlock('assistant', { type: 'tool_use', id: 'a', name: 'x', input: [] })).toBe(false);
    expect(isValidBlock('tool', { type: 'tool_result', tool_use_id: 'a', content: 'ok', is_error: 'sim' })).toBe(false);
    expect(isValidBlock('user', { type: 'attachment', attachment_id: '0192f0c4-1111-7aaa-8bbb-123456789abc' })).toBe(true);
  });

  it('remove tool_use sem resultado do fim do histórico', () => {
    const history: NeutralMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'vou ver' },
          { type: 'tool_use', id: 't1', name: 'list_caixas', input: {} },
          { type: 'tool_use', id: 't2', name: 'list_caixas', input: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[]' }] },
      { role: 'user', content: [{ type: 'text', text: 'e agora?' }] },
    ];
    const balanced = balanceToolUses(history);
    expect(balanced[1]!.content.map((b) => (b.type === 'tool_use' ? b.id : b.type))).toEqual(['text', 't1']);
    const onlyPending = balanceToolUses([
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'a', input: {} }] },
    ]);
    expect(onlyPending).toHaveLength(1);
    expect(
      blocksText([
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: '1', name: 'n', input: {} },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('corte do histórico enviado (tarefa 098): resultados longos das voltas antigas viram marcador, em degraus de keep', () => {
    /** Conversa com `turns` voltas de tool; o resultado da volta i tem `size` caracteres. */
    const history = (turns: number, size = 5000): NeutralMessage[] => [
      { role: 'user', content: [{ type: 'text', text: 'concilie' }] },
      ...Array.from({ length: turns }, (_, i): NeutralMessage[] => [
        { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'get_statement_import', input: {} }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `${i}:`.padEnd(size, 'x') }] },
      ]).flat(),
    ];
    const omitted = (chars: number) => `[omitido ${chars}]`;
    const full = (messages: NeutralMessage[]) =>
      messages.filter((m) => m.role === 'tool').map((m) => !(m.content[0] as { content: string }).content.includes('[omitido'));
    // Até 2 × keep − 1 voltas, tudo inteiro (o mesmo array volta).
    const short = history(19);
    expect(compactToolResults(short, omitted, { keep: 10 })).toBe(short);
    // 30 voltas: só as 10 últimas por inteiro; as antigas com o começo e o marcador com o tamanho original.
    const compacted = compactToolResults(history(30), omitted, { keep: 10 });
    expect(full(compacted)).toEqual([...Array(20).fill(false), ...Array(10).fill(true)]);
    const first = (compacted[2]!.content[0] as { content: string }).content;
    expect(first.startsWith('0:xxx')).toBe(true);
    expect(first.endsWith('[omitido 5000]')).toBe(true);
    expect(first.length).toBeLessThan(400);
    // Degraus: de 30 a 39 voltas o corte não muda (o prefixo fica igual para o cache); com 40, anda mais 10.
    expect(full(compactToolResults(history(39), omitted, { keep: 10 })).filter(Boolean)).toHaveLength(19);
    expect(JSON.stringify(compactToolResults(history(39), omitted, { keep: 10 }).slice(0, 41))).toBe(
      JSON.stringify(compacted.slice(0, 41)),
    );
    expect(full(compactToolResults(history(40), omitted, { keep: 10 })).filter(Boolean)).toHaveLength(10);
    // Resultados curtos ficam como estão; o gravado (a entrada) não muda.
    const small = history(30, 100);
    expect(compactToolResults(small, omitted, { keep: 10 })).toEqual(small);
    expect((history(30)[2]!.content[0] as { content: string }).content).toHaveLength(5000);
  });
});

describe('prévia (diff)', () => {
  it('criação lista os campos preenchidos, formatados', () => {
    const rows = diffRows(
      [
        { key: 'amountCents', label: 'Valor', format: 'money' },
        { key: 'dueDate', label: 'Vencimento', format: 'date' },
        { key: 'notes', label: 'Obs.' },
      ],
      { amountCents: 123456, dueDate: '2026-03-10', notes: null },
    );
    expect(rows).toEqual([
      { label: 'Valor', after: 'R$ 1.234,56' },
      { label: 'Vencimento', after: '10/03/2026' },
    ]);
  });

  it('edição mostra só o que muda (antes → depois)', () => {
    const rows = diffRows(
      [
        { key: 'name', label: 'Nome' },
        { key: 'notes', label: 'Obs.' },
      ],
      { name: 'Novo', notes: 'igual' },
      { name: 'Velho', notes: 'igual' },
    );
    expect(rows).toEqual([{ label: 'Nome', before: 'Velho', after: 'Novo' }]);
    expect(previewText({ title: 'Editar', summary: 'X', action: 'update', rows })).toContain('Nome: Velho → Novo');
  });
});

describe('SSE', () => {
  it('monta eventos de pedaços quebrados, com id, tipo e várias linhas de dados', () => {
    const parser = new SseParser();
    const text = `${formatSse({ id: 3, event: 'text_delta', data: { text: 'a\nb' } })}: ping\n\n${formatSse({ id: 4, event: 'done', data: 'x\ny' })}`;
    const events = [];
    for (let i = 0; i < text.length; i += 7) events.push(...parser.push(text.slice(i, i + 7)));
    expect(events).toEqual([
      { id: '3', event: 'text_delta', data: JSON.stringify({ text: 'a\nb' }) },
      { id: '4', event: 'done', data: 'x\ny' },
    ]);
    expect(parser.lastEventId).toBe('4');
  });

  it('aceita CRLF e evento sem nome (message)', () => {
    const parser = new SseParser();
    expect(parser.push('data: oi\r\n\r\n')).toEqual([{ id: null, event: 'message', data: 'oi' }]);
  });
});

describe('entrada do agente (admin)', () => {
  it('criação aplica os padrões; a edição parcial só traz o que veio (sem desativar nem zerar o prompt)', () => {
    expect(aiAgentCreateInput.parse({ name: 'A' })).toMatchObject({
      systemPrompt: '',
      isActive: false,
      useForFlows: false,
      colorSlot: 1,
      toolKitId: null,
      params: {},
    });
    expect(aiAgentUpdateInput.parse({ useForFlows: true })).toEqual({ useForFlows: true });
    expect(aiAgentUpdateInput.parse({ isActive: false })).toEqual({ isActive: false });
  });
});

describe('entrada do kit de ferramentas (admin)', () => {
  it('modo obrigatório (allow|ask), sem tool repetida', () => {
    expect(toolKitCreateInput.parse({ name: ' Kit ', tools: [{ name: 'list_caixas', mode: 'allow' }] })).toEqual({
      name: 'Kit',
      description: null,
      tools: [{ name: 'list_caixas', mode: 'allow' }],
    });
    expect(() => toolKitCreateInput.parse({ name: 'K', tools: [{ name: 'list_caixas' }] })).toThrow();
    expect(() => toolKitCreateInput.parse({ name: 'K', tools: [{ name: 'list_caixas', mode: 'never' }] })).toThrow();
    expect(() =>
      toolKitCreateInput.parse({
        name: 'K',
        tools: [
          { name: 'list_caixas', mode: 'allow' },
          { name: 'list_caixas', mode: 'ask' },
        ],
      }),
    ).toThrow();
  });
});

describe('resultado das tools no limite (tarefa 101)', () => {
  const row = (n: number) => ({ id: `0192d8e4-0000-7000-8000-${String(n).padStart(12, '0')}`, description: `Item ${n} `.repeat(20) });

  it('lista grande: itens inteiros até caber, JSON válido, quantos ficaram de fora e como continuar', () => {
    const list = Array.from({ length: 500 }, (_, n) => row(n));
    const text = fitResult(list, 20_000);
    expect(text.length).toBeLessThanOrEqual(20_000);
    const out = JSON.parse(text);
    expect(out.items.length).toBeGreaterThan(10);
    expect(out.items[0]).toEqual(list[0]);
    expect(out.truncated).toMatchObject({ field: null, shown: out.items.length, total: 500, omitted: 500 - out.items.length });
    expect(out.truncated.hint).toMatch(/nextOffset/);
  });

  it('objeto com uma lista: corta a maior lista e mantém o resto (saldo, totais)', () => {
    const value = { openingCents: 10, closingCents: 99, rows: Array.from({ length: 400 }, (_, n) => row(n)), tags: ['a'] };
    const out = JSON.parse(fitResult(value, 15_000));
    expect(out).toMatchObject({ openingCents: 10, closingCents: 99, tags: ['a'] });
    expect(out.truncated).toMatchObject({ field: 'rows', total: 400, shown: out.rows.length });
    // O que cabe vai inteiro, sem a marca.
    expect(JSON.parse(fitResult({ rows: [row(1)] }))).toEqual({ rows: [row(1)] });
  });

  it('texto solto e um item que sozinho passa do limite: cortados com a contagem, sem JSON quebrado', () => {
    expect(fitResult('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}… [texto cortado: 20 de 30 caracteres omitidos]`);
    const huge = JSON.parse(fitResult({ prompt: 'y'.repeat(5_000) }, 1_000));
    expect(huge.truncated.hint).toBeTruthy();
    expect(huge.preview.length).toBeLessThan(1_000);
  });

  it('o catálogo de list_agent_tools (sem descrições nem os falsos) cabe inteiro no limite', () => {
    const catalog = AGENT_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      kind: tool.kind,
      category: tool.category,
      suggestedMode: tool.secrets?.length ? 'ask' : tool.suggestedMode,
      ...(tool.destructive ? { destructive: true } : {}),
      ...(tool.adminOnly ? { adminOnly: true } : {}),
      ...(tool.secrets?.length ? { secret: true } : {}),
    }));
    expect(JSON.stringify(catalog).length).toBeLessThan(MAX_RESULT_CHARS);
    expect(fitResult(catalog)).toBe(JSON.stringify(catalog));
  });
});
