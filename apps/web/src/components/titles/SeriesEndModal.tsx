import { formatDate, type SeriesEndPreview, type SeriesEndResult, type SeriesOccurrence, type TitleDetail, t } from '@moneyflow/shared';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { ModalActions } from '../forms';
import { Button, Field, Modal } from '../ui';

const occurrenceList = (items: SeriesOccurrence[]) => items.map((o) => `#${o.occurrence} ${formatDate(o.dueDate)}`).join(', ');

/**
 * "Encerrar série…" (spec 005): escolhe o último vencimento a manter (ou sem
 * fim, para estender) e mostra a prévia do que é cancelado ou reaberto.
 */
export function SeriesEndModal({
  title,
  onClose,
  onSaved,
}: {
  title: TitleDetail;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const [noEnd, setNoEnd] = useState(false);
  // Padrão: manter até esta ocorrência (as seguintes em aberto são canceladas).
  const [endsOn, setEndsOn] = useState(title.dueDate);
  const target = noEnd ? null : endsOn || null;
  const ready = noEnd || Boolean(endsOn);
  const { data: preview, error } = useApi<SeriesEndPreview>(
    ready ? `/api/titles/${title.id}/series/end${target ? `?endsOn=${target}` : ''}` : null,
  );
  const { run, busy } = useAction();

  async function submit() {
    const result = await run(
      () => api.post<SeriesEndResult>(`/api/titles/${title.id}/series/end`, { endsOn: target }),
      (r) => t.title.endSeriesDone(r.toCancel.length, r.toReopen.length),
    );
    if (result) onSaved(result.title);
  }

  const blocked = preview?.blocked ?? [];
  const nothing = preview && preview.toCancel.length === 0 && preview.toReopen.length === 0;

  return (
    <Modal open title={t.title.endSeriesTitle} onClose={onClose}>
      <p className="text-[13px] text-muted">{t.title.endSeriesHint}</p>
      <div className="form-grid mt-3">
        <Field label={t.title.endSeriesKeepUntil}>
          <input type="date" className="field" value={endsOn} disabled={noEnd} onChange={(e) => setEndsOn(e.target.value)} autoFocus />
        </Field>
        <label className="check span-all">
          <input type="checkbox" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} /> {t.title.endSeriesNoEnd}
        </label>
      </div>
      {title.rule && (
        <p className="mt-3 text-[13px] text-muted">
          {t.title.endsOn}: {title.rule.endsOn ? formatDate(title.rule.endsOn) : t.title.endSeriesNoEnd}
        </p>
      )}
      <div className="mt-3 grid gap-2 text-[13px]">
        {error && <div className="alert warn">{error.message}</div>}
        {preview && preview.toCancel.length > 0 && (
          <div>
            <strong className="text-ink">{t.title.endSeriesCancelCount(preview.toCancel.length)}</strong>
            <div className="text-muted">{occurrenceList(preview.toCancel)}</div>
          </div>
        )}
        {preview && preview.toReopen.length > 0 && (
          <div>
            <strong className="text-ink">{t.title.endSeriesReopenCount(preview.toReopen.length)}</strong>
            <div className="text-muted">{occurrenceList(preview.toReopen)}</div>
          </div>
        )}
        {blocked.length > 0 && (
          <div className="alert warn">
            <span>
              {t.title.endSeriesBlocked} {occurrenceList(blocked)}
            </span>
          </div>
        )}
        {nothing && blocked.length === 0 && <p className="text-faint">{t.title.endSeriesNothing}</p>}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button
          variant={preview && preview.toCancel.length > 0 ? 'danger' : 'primary'}
          disabled={busy || !preview || blocked.length > 0}
          onClick={() => void submit()}
        >
          {t.title.endSeriesApply}
        </Button>
      </ModalActions>
    </Modal>
  );
}
