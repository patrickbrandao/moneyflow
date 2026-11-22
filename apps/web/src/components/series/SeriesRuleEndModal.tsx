import { formatDate, type SeriesDto, type SeriesEndPreview, type SeriesOccurrence, t, todayIso } from '@moneyflow/shared';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { ModalActions } from '../forms';
import { Button, Field, Modal } from '../ui';

const O = t.contracts.obligation;

const occurrenceList = (items: SeriesOccurrence[]) => items.map((o) => `#${o.occurrence} ${formatDate(o.dueDate)}`).join(', ');

/** "Encerrar ou estender" a série pela regra (vale também para a cobrança no cartão). */
export function SeriesRuleEndModal({
  series,
  onClose,
  onSaved,
}: {
  series: SeriesDto;
  onClose: () => void;
  onSaved: (s: SeriesDto) => void;
}) {
  const [noEnd, setNoEnd] = useState(false);
  const [endsOn, setEndsOn] = useState(series.endsOn ?? todayIso());
  const target = noEnd ? null : endsOn || null;
  const ready = noEnd || Boolean(endsOn);
  // A prévia é a da data na tela (tarefa 117): trocada a data, o botão desliga até a nova chegar.
  const {
    data: preview,
    error,
    loading,
  } = useApi<SeriesEndPreview>(ready ? `/api/series/${series.id}/end${target ? `?endsOn=${target}` : ''}` : null);
  const { run, busy } = useAction();

  async function submit() {
    const result = await run(
      () => api.post<SeriesEndPreview & { created: number; series: SeriesDto }>(`/api/series/${series.id}/end`, { endsOn: target }),
      (r) => O.endDone(r.toCancel.length, r.toReopen.length),
    );
    if (result) onSaved(result.series);
  }

  const blocked = preview?.blocked ?? [];
  const nothing = preview && preview.toCancel.length === 0 && preview.toReopen.length === 0;
  return (
    <Modal open title={`${t.title.endSeriesTitle} · ${series.description}`} onClose={onClose}>
      <div data-testid="series-end-form">
        <p className="text-[13px] text-muted">{t.title.endSeriesHint}</p>
        <div className="form-grid mt-3">
          <Field label={t.title.endSeriesKeepUntil}>
            <input
              type="date"
              className="field"
              value={endsOn}
              disabled={noEnd}
              onChange={(e) => setEndsOn(e.target.value)}
              aria-label={t.title.endSeriesKeepUntil}
            />
          </Field>
          <label className="check span-all">
            <input type="checkbox" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} /> {t.title.endSeriesNoEnd}
          </label>
        </div>
        <p className="mt-3 text-[13px] text-muted">
          {t.title.endsOn}: {series.endsOn ? formatDate(series.endsOn) : t.title.endSeriesNoEnd}
        </p>
        <div className="mt-3 grid gap-2 text-[13px]">
          {error && <div className="alert warn">{error.message}</div>}
          {ready && loading && !error && <p className="text-faint">{t.common.loading}</p>}
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
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button
          variant={preview && preview.toCancel.length > 0 ? 'danger' : 'primary'}
          disabled={busy || !preview || blocked.length > 0}
          onClick={() => void submit()}
          data-testid="series-end-submit"
        >
          {t.title.endSeriesApply}
        </Button>
      </ModalActions>
    </Modal>
  );
}
