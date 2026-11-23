/*
 * Avisos da importação de extrato (spec 009) que a tela, a prévia da tool
 * import_statement e a resposta do import mostram do mesmo jeito.
 */
import { formatDate } from './dates';
import { statementsStrings as s } from './i18n/areas/statements';
import { formatBRL } from './money';
import type { StatementFitidCollisions, StatementInvalidRows } from './types';

/** Quantos exemplos cada aviso cita. */
const EXAMPLES = 3;

/**
 * Os avisos de um import: as linhas do CSV que não foram lidas (tarefa 140) e
 * as transações com o FITID de outra que entraram como linhas novas (tarefa 089).
 */
export function statementImportNotices(info: {
  invalidRows?: StatementInvalidRows | null;
  fitidCollisions?: StatementFitidCollisions | null;
}): string[] {
  const out: string[] = [];
  if (info.invalidRows?.total) {
    const examples = info.invalidRows.rows.slice(0, EXAMPLES).map((r) => s.invalidRowExample(r.row, r.message));
    out.push(s.invalidRows(info.invalidRows.total, examples.join('; ')));
  }
  if (info.fitidCollisions?.total) {
    const examples = info.fitidCollisions.lines
      .slice(0, EXAMPLES)
      .map((l) => s.fitidCollisionExample(l.fitid, formatDate(l.postedOn), formatBRL(l.amountCents)));
    out.push(s.fitidCollisions(info.fitidCollisions.total, examples.join('; ')));
  }
  return out;
}
