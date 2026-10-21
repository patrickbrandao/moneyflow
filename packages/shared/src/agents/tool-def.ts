import { z } from 'zod';
import { id, isoDate } from '../schemas';

/*
 * Tipos e auxiliares do registro das tools dos agentes (specs 011, 021 e 027),
 * compartilhados pelos blocos do registro (tools.ts e tools-operation.ts).
 */

export type AgentToolKind = 'read' | 'write';

/** allow = executa sem perguntar; ask = mostra o cartão "Aplicar?" e espera o usuário. */
export const AGENT_TOOL_MODES = ['allow', 'ask'] as const;
export type AgentToolMode = (typeof AGENT_TOOL_MODES)[number];

/** Categorias fixas, na ordem da tela (nomes em t.agents.toolCategories). */
export const AGENT_TOOL_CATEGORIES = [
  'search',
  'caixas',
  'entities',
  'titles',
  'cards',
  'contracts',
  'notes',
  'reconciliation',
  'imports',
  'categories',
  'reports',
  'messages',
  'closing',
  'users',
  'ai',
  'backup',
] as const;
export type AgentToolCategory = (typeof AGENT_TOOL_CATEGORIES)[number];

export type AgentToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  kind: AgentToolKind;
  category: AgentToolCategory;
  /** Modo usado quando a tool é marcada num kit. */
  suggestedMode: AgentToolMode;
  /** Escrita que apaga/desfaz algo (anotação destructiveHint no MCP). */
  destructive?: boolean;
  /** Só administrador: fora da lista quando quem aciona não é admin (mesmo no kit). */
  adminOnly?: boolean;
  /**
   * Segredos da tool (spec 027): NÃO fazem parte do schema enviado ao modelo.
   * A prévia diz os campos (`secretFields`); o usuário digita os valores no
   * cartão de aprovação e eles vão na decisão direto ao serviço (o handler os
   * recebe em `meta.secrets`). A tool é sempre ask e fica fora do /mcp.
   */
  secrets?: readonly string[];
  /** Gera um arquivo (vira anexo de uma mensagem do agente na sessão): fora do /mcp, que não tem sessão. */
  producesFile?: boolean;
  input: S;
};

export const define = <const N extends string, S extends z.ZodType>(
  def: Omit<AgentToolDef<S>, 'suggestedMode' | 'name'> & { name: N; suggestedMode?: AgentToolMode },
): AgentToolDef<S> & { name: N } => ({
  suggestedMode: def.kind === 'read' ? 'allow' : 'ask',
  ...def,
});

export const date = isoDate.describe('Data no formato AAAA-MM-DD.');
export const optionalDate = date.optional();
export const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Máximo de itens (padrão ${fallback}).`);
/** Anexo usado como entrada (spec 027): um anexo desta sessão (no /mcp, um anexo que o dono do token lê). */
export const attachmentId = id.describe(
  'Id do anexo enviado nesta sessão (aparece no texto como "attachmentId" ao lado do nome do arquivo).',
);
