import { formatDate, isIsoDate } from '../dates';
import { formatBRL } from '../money';

/*
 * Prévia/diff legível de uma tool de escrita (cartão "Aplicar?", spec 011):
 * gravada em ai_tool_confirmations.preview e mostrada antes de executar.
 * Nunca carrega senhas nem tokens.
 */

export type PreviewAction = 'create' | 'update' | 'delete' | 'send' | 'other';
export type PreviewRow = { label: string; before?: string | null; after: string | null };
/**
 * Campo de segredo do cartão de aprovação (spec 027): só o nome e o rótulo,
 * nunca o valor. `key` é a chave em `secrets` da decisão.
 */
export type ToolSecretField = { key: string; label: string; required: boolean; hint?: string };

export type ToolPreview = {
  title: string;
  summary: string;
  action: PreviewAction;
  rows: PreviewRow[];
  warnings?: string[];
  /** Tools com segredo: um campo de senha por item, digitado no cartão. */
  secretFields?: ToolSecretField[];
};

export type PreviewField = {
  key: string;
  label: string;
  /** money = centavos → R$; date = AAAA-MM-DD → dd/mm/aaaa; bool = Sim/Não; ou uma função. */
  format?: 'money' | 'date' | 'bool' | ((value: unknown) => string);
};

/** Valor como texto para a prévia (null = vazio). */
export function previewValue(value: unknown, format?: PreviewField['format']): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof format === 'function') return format(value);
  if (format === 'money' && typeof value === 'number') return formatBRL(value);
  if (format === 'date' && typeof value === 'string' && isIsoDate(value)) return formatDate(value);
  if (format === 'bool' || typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Linhas do diff. Sem `before` (criação), lista os campos preenchidos de
 * `after`; com `before` (edição), só os que mudam e que estão em `after`.
 */
export function diffRows(fields: PreviewField[], after: Record<string, unknown>, before?: Record<string, unknown> | null): PreviewRow[] {
  const rows: PreviewRow[] = [];
  for (const field of fields) {
    if (before) {
      if (!(field.key in after) || after[field.key] === undefined) continue;
      const from = previewValue(before[field.key], field.format);
      const to = previewValue(after[field.key], field.format);
      if (from !== to) rows.push({ label: field.label, before: from, after: to });
    } else {
      const to = previewValue(after[field.key], field.format);
      if (to !== null) rows.push({ label: field.label, after: to });
    }
  }
  return rows;
}

/** Texto curto da prévia (para o modelo e para logs). */
export function previewText(preview: ToolPreview): string {
  const lines = [`${preview.title}: ${preview.summary}`];
  for (const row of preview.rows) {
    lines.push(
      row.before !== undefined ? `- ${row.label}: ${row.before ?? '—'} → ${row.after ?? '—'}` : `- ${row.label}: ${row.after ?? '—'}`,
    );
  }
  for (const warning of preview.warnings ?? []) lines.push(`! ${warning}`);
  return lines.join('\n');
}
