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

/** Voltas de tool mantidas por inteiro no histórico enviado (tarefa 098): de `keep` a `2 × keep − 1` mais recentes. */
export const HISTORY_FULL_TOOL_TURNS = 10;
/** Resultado de tool antigo com mais caracteres que isto vira o marcador (os curtos ficam como estão). */
export const HISTORY_COMPACT_MIN_CHARS = 2000;
/** Começo do resultado antigo mantido antes do marcador. */
const HISTORY_COMPACT_HEAD = 300;

/**
 * Corte do histórico ENVIADO ao modelo (tarefa 098, spec 026); o gravado em
 * ai_messages não muda. Os resultados de tool longos das voltas antigas viram
 * o começo do texto mais um marcador (`omitted`, com o tamanho original). As
 * voltas mantidas por inteiro andam em degraus de `keep`: o corte só muda a
 * cada `keep` voltas, e entre um degrau e outro o prefixo do histórico fica
 * igual (o cache do histórico da spec 022 continua valendo). Determinístico:
 * o mesmo histórico dá sempre o mesmo corte.
 */
export function compactToolResults(
  messages: NeutralMessage[],
  omitted: (chars: number) => string,
  options: { keep?: number; minChars?: number } = {},
): NeutralMessage[] {
  const keep = Math.max(1, options.keep ?? HISTORY_FULL_TOOL_TURNS);
  const minChars = options.minChars ?? HISTORY_COMPACT_MIN_CHARS;
  const turns = messages.filter((m) => m.role === 'tool').length;
  const cut = Math.max(0, Math.floor((turns - keep) / keep) * keep);
  if (cut === 0) return messages;
  let seen = 0;
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    seen += 1;
    if (seen > cut || !message.content.some((b) => b.content.length > minChars)) return message;
    return {
      role: 'tool',
      content: message.content.map((block) =>
        block.content.length > minChars
          ? { ...block, content: `${block.content.slice(0, HISTORY_COMPACT_HEAD)}…\n${omitted(block.content.length)}` }
          : block,
      ),
    };
  });
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
