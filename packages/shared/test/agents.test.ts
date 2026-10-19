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
  diffRows,
  effectiveToolMode,
  formatSse,
  isValidBlock,
  kitTools,
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
    // 13 da conciliação e as 5 das receitas (spec 030).
    expect(AGENT_TOOLS.filter((tool) => tool.category === 'reconciliation')).toHaveLength(18);
    expect(agentTool('send_telegram_message')).toMatchObject({ category: 'messages', suggestedMode: 'ask' });
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
        'add_contract_amendment',
        'terminate_contract',
        'decide_contract_renewal',
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
    expect(AGENT_TOOLS.some((tool) => tool.name === 'upload_file')).toBe(false);
    expect(uploadMime('extrato.OFX')).toBe('application/x-ofx');
    expect(uploadMime('arquivo.bin')).toBe('application/octet-stream');
    expect(uploadMime('nota.xml', 'text/xml')).toBe('text/xml');
    const balance = agentTool('set_statement_import_balance')!.input;
    const importId = '0192d8e4-0000-7000-8000-000000000002';
    expect(balance.parse({ importId, mode: 'set', bankBalanceCents: -1, bankBalanceOn: '2019-07-31' })).toMatchObject({ mode: 'set' });
    expect(() => balance.parse({ importId, mode: 'set', bankBalanceCents: 100 })).toThrow();
    expect(() => balance.parse({ importId, mode: 'clear', bankBalanceCents: 100, bankBalanceOn: '2019-07-31' })).toThrow();
    expect(balance.parse({ importId, mode: 'file' })).toMatchObject({ mode: 'file' });
    expect(names(AGENT_TOOLS.filter((tool) => tool.category === 'categories'))).toEqual(
      [
        'list_categories',
        'create_category',
        'update_category',
        'archive_category',
        'list_classification_rules',
        'create_classification_rule',
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
    // Contrato pelo agente: sempre rascunho (o campo activate não existe na tool).
    expect(Object.keys(toolJsonSchema(agentTool('create_contract')!).properties as object)).not.toContain('activate');
    // Importação: exatamente um alvo, e o mapeamento salvo ou informado (não os dois).
    const importInput = agentTool('import_statement')!.input;
    const attachmentId = '0192d8e4-0000-7000-8000-000000000001';
    expect(() => importInput.parse({ attachmentId })).toThrow();
    expect(importInput.parse({ attachmentId, accountId: attachmentId })).toMatchObject({ accountId: attachmentId });
    expect(() => agentTool('decide_contract_renewal')!.input.parse({ contractId: attachmentId, decision: 'approve' })).toThrow();
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
