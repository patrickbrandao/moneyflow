import { agentTool, t } from '@moneyflow/shared';

/* Fora do `format.ts` (tarefa 128): o registro das tools (com os schemas) fica só no pedaço da conversa. */

const u = t.agentsUi;

/** Nome amigável da tool: título do registro interno ou "servidor › tool" para MCP ("servidor__tool"). */
export function toolLabel(name: string, fallbackTitle?: string | null): string {
  const internal = agentTool(name);
  if (internal) return internal.title;
  if (fallbackTitle && fallbackTitle !== name) return fallbackTitle;
  const cut = name.indexOf('__');
  if (cut > 0) return `${name.slice(cut + 2)} (${u.tool.mcp(name.slice(0, cut))})`;
  return name;
}
