import { diffStats, diffText } from '@moneyflow/shared';
import { useMemo } from 'react';
import { cx } from '../ui';

/**
 * O diff de linhas entre dois textos, com as contagens (+ incluídas, −
 * removidas). Usado nas versões do documento markdown do contrato e nas do
 * prompt do agente (tarefa 182). Versões muito diferentes saem com o miolo
 * resumido (tarefa 112): o aviso `truncatedNote` aparece acima do diff.
 */
export function LineDiff({
  before,
  after,
  title,
  noDiff,
  truncatedNote,
  testId,
}: {
  before: string;
  after: string;
  title: string;
  /** Texto quando as duas versões são iguais. */
  noDiff: string;
  /** Aviso de diff resumido (versões muito diferentes; as contagens viram limites superiores). */
  truncatedNote: string;
  testId?: string;
}) {
  const { lines, truncated } = useMemo(() => diffText(before, after), [before, after]);
  const stats = diffStats(lines);
  return (
    <div>
      <p className="mb-2 text-sm font-medium">
        {title} <span className="text-ok">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
      </p>
      {truncated && (
        <p className="mb-2 text-sm text-warn" role="status" data-testid={testId ? `${testId}-truncated` : undefined}>
          {truncatedNote}
        </p>
      )}
      {stats.added + stats.removed === 0 ? (
        <p className="hint">{noDiff}</p>
      ) : (
        <div className="panel diff-view" role="group" aria-label={title} data-testid={testId}>
          {lines.map((line, i) => (
            <div key={`${i}-${line.kind}`} className={cx('diff-line', line.kind)}>
              <span className="ln">{line.oldLine ?? ''}</span>
              <span className="ln">{line.newLine ?? ''}</span>
              <span className="mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
              <span className="txt">{line.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
