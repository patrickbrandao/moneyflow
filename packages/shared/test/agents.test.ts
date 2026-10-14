import { describe, expect, it } from 'vitest';
import {
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
  type NeutralMessage,
  previewText,
  SseParser,
  t,
  toolJsonSchema,
  toolKitCreateInput,
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

  it('categorias e modo sugerido (spec 021): toda tool numa categoria com nome; leituras e notify_user allow, demais escritas ask', () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_TOOL_CATEGORIES).toContain(tool.category);
      expect(tool.suggestedMode).toBe(tool.kind === 'read' || tool.name === 'notify_user' ? 'allow' : 'ask');
    }
    for (const category of AGENT_TOOL_CATEGORIES) {
      expect(t.agents.toolCategories[category]).toBeTruthy();
      expect(AGENT_TOOLS.some((tool) => tool.category === category)).toBe(true);
    }
    expect(AGENT_TOOLS.filter((tool) => tool.category === 'reconciliation')).toHaveLength(13);
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
