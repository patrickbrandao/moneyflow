import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { suggestClassifications } from '../services/reconciliation';

/*
 * IA nos fluxos existentes (specs 009, 010, 011): leitura de documento
 * (title-entry/document) e sugestões de classificação das linhas de extrato
 * sem regra. Cada uso é uma execução de agente normal (credenciais pelo banco,
 * uso e custo em ai_usage, auditoria como agente), numa conversa arquivada
 * marcada em screen_context.purpose; o agente responde JSON e não usa tools.
 */

export const FLOW_PURPOSES = ['document_reading', 'classify_lines', 'contract_reading', 'contract_markdown'] as const;
/** Fluxos que a API espera terminar (a resposta volta na requisição): não avisam no sino. */
export const SYNC_FLOW_PURPOSES: readonly string[] = ['document_reading', 'contract_reading', 'contract_markdown'];
export type FlowPurpose = (typeof FLOW_PURPOSES)[number];

export function flowSystemPrompt(purpose: FlowPurpose): string {
  if (purpose === 'contract_reading') {
    return [
      'Tarefa: ler o contrato anexado (PDF) e extrair os dados para cadastrá-lo. O titular da caixa está no contexto da mensagem.',
      'Responda SOMENTE com um objeto JSON, sem texto em volta, com as chaves:',
      '{"counterpartyName": string|null, "counterpartyDocument": string|null (CPF/CNPJ da outra parte, só dígitos e letras),',
      '"direction": "receivable"|"payable"|null (receivable se o titular presta o serviço e recebe; payable se o titular contrata e paga),',
      '"name": string|null (objeto do contrato, curto), "contractNumber": string|null, "startsOn": "AAAA-MM-DD"|null,',
      '"durationMonths": inteiro|null, "totalCents": inteiro|null (valor total do período, em centavos), "installmentCents": inteiro|null (valor de cada parcela),',
      '"periodicity": "monthly"|"quarterly"|"semiannual"|"annual"|"single"|null, "dueDay": inteiro 1–31|null, "autoRenew": boolean|null,',
      '"noticeDays": inteiro|null (aviso prévio em dias), "readjustmentIndex": "ipca"|"igpm"|"inpc"|"other"|"none"|null,',
      '"readjustmentBaseDate": "AAAA-MM-DD"|null, "terminationPenalty": string|null (multa rescisória, resumida)}.',
      'Use null para o que não estiver no documento. Não invente dados.',
    ].join('\n');
  }
  if (purpose === 'contract_markdown') {
    return [
      'Tarefa: converter o contrato anexado (PDF) em markdown fiel ao texto original.',
      'Preserve títulos, cláusulas, numeração, listas e tabelas (tabelas em markdown). Não resuma, não comente e não invente texto.',
      'Responda SOMENTE com o markdown do documento, sem cercas de código em volta.',
    ].join('\n');
  }
  if (purpose === 'document_reading') {
    return [
      'Tarefa: ler o documento anexado (boleto, nota fiscal, recibo ou comprovante) e extrair os dados de um título a pagar.',
      'Responda SOMENTE com um objeto JSON, sem texto em volta, com as chaves:',
      '{"kind": "boleto"|"invoice"|"receipt"|"unknown", "entityName": string|null, "document": string|null (CPF/CNPJ do beneficiário/emitente, só dígitos e letras),',
      '"amountCents": inteiro|null (valor em centavos), "dueDate": "AAAA-MM-DD"|null, "boletoLine": string|null (linha digitável só com dígitos),',
      '"pixPayload": string|null (PIX copia-e-cola), "description": string|null (descrição curta do que é a cobrança)}.',
      'Use null para o que não estiver legível. Não invente dados.',
    ].join('\n');
  }
  return [
    'Tarefa: sugerir entidade e categoria para linhas de extrato bancário que não casaram com nenhuma regra.',
    'Para cada linha use APENAS ids das listas de candidatos fornecidas (entidades da própria linha e categorias do tipo certo).',
    'Responda SOMENTE com um objeto JSON: {"suggestions": [{"lineId": "...", "entityId": "..."|null, "categoryId": "..."|null}]}.',
    'Omita a linha se não tiver confiança razoável.',
  ].join('\n');
}

/** Primeiro objeto JSON do texto (tolerante a ```json … ```). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aplica o resultado do fluxo (classificação: grava as sugestões como agente). */
export async function applyFlowResult(ctx: ServiceContext, purpose: FlowPurpose, screen: Record<string, unknown>, text: string) {
  if (purpose !== 'classify_lines') return;
  const parsed = extractJson(text) as { suggestions?: { lineId?: string; entityId?: string | null; categoryId?: string | null }[] } | null;
  const allowed = new Set(Array.isArray(screen.lineIds) ? (screen.lineIds as string[]) : []);
  const suggestions = (parsed?.suggestions ?? [])
    .filter((s) => typeof s.lineId === 'string' && allowed.has(s.lineId))
    .map((s) => ({
      lineId: s.lineId!,
      entityId: typeof s.entityId === 'string' && UUID.test(s.entityId) ? s.entityId : null,
      categoryId: typeof s.categoryId === 'string' && UUID.test(s.categoryId) ? s.categoryId : null,
    }))
    .filter((s) => s.entityId || s.categoryId);
  if (suggestions.length === 0) return;
  // Ids inexistentes viram nulos (o modelo pode errar).
  const ids = [...new Set(suggestions.flatMap((s) => [s.entityId, s.categoryId]).filter(Boolean))] as string[];
  const known = await ctx.db.execute<{ id: string }>(sql`
    SELECT id FROM entities WHERE id = ANY (${`{${ids.join(',')}}`}::uuid[])
    UNION ALL SELECT id FROM categories WHERE id = ANY (${`{${ids.join(',')}}`}::uuid[])`);
  const ok = new Set(known.rows.map((r) => r.id));
  await suggestClassifications(
    ctx,
    suggestions.map((s) => ({
      lineId: s.lineId,
      entityId: s.entityId && ok.has(s.entityId) ? s.entityId : null,
      categoryId: s.categoryId && ok.has(s.categoryId) ? s.categoryId : null,
    })),
  );
}
