import { GitCompare, RotateCcw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button, cx } from '../ui';

/*
 * Lista de versões com a comparação A → B, o conteúdo de uma e o restaurar
 * (tarefa 182): a mesma tela para as versões do documento markdown do contrato
 * e para as do prompt do agente. A confirmação e a chamada do restaurar ficam
 * com quem usa (`onRestore`), porque os textos e a rota mudam.
 */

export type VersionItem = {
  id: string;
  version: number;
  /** Nome da versão na lista (com o selo "atual", se for o caso). */
  title: ReactNode;
  sub: ReactNode;
  current: boolean;
  testId?: string;
};

export function VersionCompare({
  items,
  name,
  labels,
  canRestore,
  onRestore,
  renderContent,
  renderDiff,
  className,
  listClassName,
  listTestId,
}: {
  /** Da mais nova para a mais antiga. */
  items: VersionItem[];
  /** Prefixo dos grupos de rádio A e B. */
  name: string;
  labels: {
    compareA: (version: number) => string;
    compareB: (version: number) => string;
    restore: string;
    /** O botão que volta do conteúdo de uma versão para a comparação. */
    compare: string;
    /** A dica quando não há duas versões marcadas. */
    compareHint: string;
  };
  canRestore: boolean;
  /** Pede a confirmação e restaura; true = restaurada (a seleção volta ao padrão). */
  onRestore: (item: VersionItem) => Promise<boolean>;
  renderContent: (id: string) => ReactNode;
  renderDiff: (leftId: string, rightId: string) => ReactNode;
  className?: string;
  listClassName?: string;
  listTestId?: string;
}) {
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  // Sem escolha, A é a penúltima e B a última.
  const a = left ?? items[1]?.id ?? null;
  const b = right ?? items[0]?.id ?? null;

  async function restore(item: VersionItem) {
    if (!(await onRestore(item))) return;
    setShown(null);
    setLeft(null);
    setRight(null);
  }

  return (
    <div className={className}>
      <ul className={cx('item-list', listClassName)} data-testid={listTestId}>
        {items.map((v) => (
          <li key={v.id} className={cx('item', shown === v.id && 'bg-s2')} data-testid={v.testId}>
            <button
              type="button"
              className="grow min-w-0 cursor-pointer text-left"
              aria-pressed={shown === v.id}
              onClick={() => setShown(shown === v.id ? null : v.id)}
            >
              <span className="row-title">{v.title}</span>
              <span className="row-sub">{v.sub}</span>
            </button>
            <span className="row-actions">
              <label className="check" title={labels.compareA(v.version)}>
                <input
                  type="radio"
                  name={`${name}-a`}
                  checked={a === v.id}
                  onChange={() => setLeft(v.id)}
                  aria-label={labels.compareA(v.version)}
                />{' '}
                A
              </label>
              <label className="check" title={labels.compareB(v.version)}>
                <input
                  type="radio"
                  name={`${name}-b`}
                  checked={b === v.id}
                  onChange={() => setRight(v.id)}
                  aria-label={labels.compareB(v.version)}
                />{' '}
                B
              </label>
              {canRestore && !v.current && (
                <button
                  type="button"
                  className="row-action"
                  title={labels.restore}
                  aria-label={labels.restore}
                  onClick={() => void restore(v)}
                >
                  <RotateCcw />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="min-w-0">
        {shown ? (
          <>
            {renderContent(shown)}
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShown(null)}>
              <GitCompare /> {labels.compare}
            </Button>
          </>
        ) : a && b && a !== b ? (
          renderDiff(a, b)
        ) : (
          <p className="hint">
            <GitCompare className="inline size-4" /> {labels.compareHint}
          </p>
        )}
      </div>
    </div>
  );
}
