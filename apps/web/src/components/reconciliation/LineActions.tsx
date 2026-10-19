import { type CardOverview, formatDate, type StatementLineRow, t } from '@moneyflow/shared';
import { Ban, Check, Link2, Plus, RotateCcw, Sparkles, Tag, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { CategoryLabel } from '../domain';
import { useToast } from '../Toast';
import { cx } from '../ui';
import { CreateModal, MatchModal, UnmatchModal } from './LineModals';

const s = t.statements;

function RowAction({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className={cx('row-action', danger && 'danger')} title={label} aria-label={label} onClick={onClick}>
      {icon}
    </button>
  );
}

/** Par da linha no app (conciliado ou sugerido). */
export function LinePair({ line }: { line: StatementLineRow }) {
  if (!line.target) return <span className="text-faint text-xs">{s.noPair}</span>;
  return (
    <span className="rec-pair">
      <span className="row-title text-[13px]">{line.target.description}</span>
      <span className="row-sub">
        {s.targetKinds[line.target.kind]} · {formatDate(line.target.date)}
        {line.target.entityName ? ` · ${line.target.entityName}` : ''}
      </span>
    </span>
  );
}

/** Entidade e categoria da linha, com a origem (regra, agente ou usuário). */
export function LineClassification({ line }: { line: StatementLineRow }) {
  if (!line.entityName && !line.categoryName) return <span className="text-faint text-xs">—</span>;
  return (
    <span className="rec-pair">
      {line.entityName && <span className="text-[13px]">{line.entityName}</span>}
      {line.categoryName && <CategoryLabel name={line.categoryName} slot={line.categoryColorSlot} />}
      {line.classificationSource === 'agent' ? (
        <span className="ai-tag">
          <Sparkles /> {s.bySource.agent}
        </span>
      ) : (
        line.classificationSource && <span className="row-sub">{s.bySource[line.classificationSource]}</span>
      )}
    </span>
  );
}

type Dialog = 'match' | 'create' | 'classify' | 'unmatch' | null;

/**
 * Ações de uma linha de extrato (confirmar, casar à mão, lançar, classificar,
 * desfazer, ignorar e voltar) com os modais delas. Usada no lote e na busca.
 * `onConfirm` troca a confirmação avulsa (o lote mostra as falhas na lista dele).
 */
export function LineActions({
  line,
  isCard,
  caixaId,
  card,
  onChanged,
  onConfirm,
}: {
  line: StatementLineRow;
  isCard: boolean;
  caixaId: string;
  card: CardOverview | null;
  onChanged: () => void;
  onConfirm?: (lineId: string) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run } = useAction();
  const toast = useToast();

  async function confirmLine() {
    if (onConfirm) return onConfirm(line.id);
    const result = await run(() =>
      api.post<{ confirmed: number; failed: { lineId: string; message: string }[] }>('/api/statement-lines/confirm', {
        lineIds: [line.id],
      }),
    );
    if (!result) return;
    if (result.failed[0]) toast.error(result.failed[0].message);
    else toast.success(s.confirmed(result.confirmed));
    onChanged();
  }

  async function lineAction(action: 'unmatch' | 'ignore' | 'unignore', message: string) {
    if (await run(() => api.post(`/api/statement-lines/${line.id}/${action}`), message)) onChanged();
  }

  const done = () => {
    setDialog(null);
    onChanged();
  };

  return (
    <>
      <span className="row-actions">
        {line.status === 'suggested' && <RowAction icon={<Check />} label={s.confirmLine} onClick={() => void confirmLine()} />}
        {(line.status === 'new' || line.status === 'suggested') && (
          <>
            <RowAction icon={<Link2 />} label={s.matchManual} onClick={() => setDialog('match')} />
            <RowAction icon={<Plus />} label={s.create} onClick={() => setDialog('create')} />
            <RowAction icon={<Tag />} label={s.classify} onClick={() => setDialog('classify')} />
          </>
        )}
        {(line.status === 'matched' || line.status === 'suggested') && (
          <RowAction
            icon={<Undo2 />}
            label={s.unmatch}
            onClick={() => (line.createdEntry ? setDialog('unmatch') : void lineAction('unmatch', s.unmatched))}
          />
        )}
        {line.status === 'ignored' ? (
          <RowAction icon={<RotateCcw />} label={s.unignore} onClick={() => void lineAction('unignore', s.unignored)} />
        ) : (
          line.status !== 'matched' && (
            <RowAction icon={<Ban />} label={s.ignore} danger onClick={() => void lineAction('ignore', s.ignored)} />
          )
        )}
      </span>
      {dialog === 'match' && <MatchModal line={line} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'unmatch' && <UnmatchModal line={line} onClose={() => setDialog(null)} onDone={done} />}
      {(dialog === 'create' || dialog === 'classify') && (
        <CreateModal
          line={line}
          isCard={isCard}
          caixaId={caixaId}
          card={card}
          classifyOnly={dialog === 'classify'}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
    </>
  );
}
