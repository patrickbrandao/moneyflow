/*
 * Blocos neutros das mensagens dos agentes (spec 011), iguais aos do banco
 * (ai_messages.content, migration 0026). Os adaptadores de LLM convertem de e
 * para o formato de cada provedor; o histórico guarda só estes blocos.
 */

export type AiRole = 'user' | 'assistant' | 'tool';

export type TextBlock = { type: 'text'; text: string };
export type AttachmentBlock = { type: 'attachment'; attachment_id: string; file_name?: string; mime_type?: string };
/** Raciocínio do modelo. `signature` e `provider` permitem devolvê-lo intacto ao mesmo provedor. */
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string; provider?: string; model?: string };
export type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string; provider?: string; model?: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type UserBlock = TextBlock | AttachmentBlock;
export type AssistantBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;
export type AiBlock = UserBlock | AssistantBlock | ToolResultBlock;

export type NeutralMessage =
  | { role: 'user'; content: UserBlock[] }
  | { role: 'assistant'; content: AssistantBlock[] }
  | { role: 'tool'; content: ToolResultBlock[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Valida um bloco para o papel (mesma regra de ai_message_content_valid no banco). */
export function isValidBlock(role: AiRole, block: unknown): block is AiBlock {
  if (!isObject(block) || typeof block.type !== 'string') return false;
  const allowed: Record<AiRole, string[]> = {
    user: ['text', 'attachment'],
    assistant: ['text', 'thinking', 'redacted_thinking', 'tool_use'],
    tool: ['tool_result'],
  };
  if (!allowed[role].includes(block.type)) return false;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string';
    case 'attachment':
      return typeof block.attachment_id === 'string' && /^[0-9a-f-]{36}$/i.test(block.attachment_id);
    case 'tool_use':
      return typeof block.id === 'string' && typeof block.name === 'string' && isObject(block.input);
    case 'tool_result':
      return (
        typeof block.tool_use_id === 'string' && 'content' in block && (block.is_error === undefined || typeof block.is_error === 'boolean')
      );
    default:
      return true;
  }
}

/** Texto visível de uma mensagem (blocos text unidos). */
export function blocksText(blocks: readonly AiBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Corta o histórico para não deixar tool_use sem tool_result (o provedor
 * recusaria): remove do fim as mensagens do assistente com tool_use cujo
 * resultado não veio.
 */
export function balanceToolUses(messages: NeutralMessage[]): NeutralMessage[] {
  const out = [...messages];
  const answered = new Set<string>();
  for (const m of out) if (m.role === 'tool') for (const b of m.content) answered.add(b.tool_use_id);
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const m = out[i]!;
    if (m.role !== 'assistant') continue;
    const pending = m.content.some((b) => b.type === 'tool_use' && !answered.has(b.id));
    if (pending) {
      const kept = m.content.filter((b) => b.type !== 'tool_use' || answered.has(b.id));
      if (kept.some((b) => b.type === 'text' || b.type === 'tool_use')) out[i] = { role: 'assistant', content: kept };
      else out.splice(i, 1);
    }
  }
  return out;
}
