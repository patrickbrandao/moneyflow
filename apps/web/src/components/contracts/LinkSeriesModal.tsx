import { type ContractDetail, formatAccounting, type SeriesDto, t } from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { ModalActions } from '../forms';
import { calendarText } from '../series/series-text';
import { Badge, Button, Modal } from '../ui';

const O = t.contracts.obligation;

/** "Ligar série existente" (spec 034): uma série solta com a contraparte vira obrigação do contrato. */
export function LinkSeriesModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const list = useApi<SeriesDto[]>(`/api/series?entityId=${contract.entityId}&unlinked=1`);
  const rows = (list.data ?? []).filter((s) => s.direction === contract.direction && s.installmentsTotal === null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ruleId) return;
    const saved = await run(() => api.post<ContractDetail>(`/api/contracts/${contract.id}/obligations/link`, { ruleId }), O.linked);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={O.linkTitle} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} data-testid="link-series-form">
        <div className="modal-body">
          <p className="hint mb-3">{O.linkHint}</p>
          {list.data && rows.length === 0 && <p className="hint">{O.linkNone}</p>}
          {!list.data && <p className="hint">{t.common.loading}</p>}
          <div className="item-list" role="radiogroup" aria-label={O.linkTitle}>
            {rows.map((s) => (
              <div key={s.id} className="item">
                <label className="check grow min-w-0" data-testid="link-series-option">
                  <input type="radio" name="link-series" checked={ruleId === s.id} onChange={() => setRuleId(s.id)} />
                  <span className="min-w-0">
                    <span className="row-title">{s.description}</span>
                    <span className="row-sub">
                      {s.kind === 'account' ? (s.accountName ?? s.caixaName) : s.caixaName} · {calendarText(s)} ·{' '}
                      {formatAccounting(s.amountCents)}
                    </span>
                  </span>
                </label>
                <Badge tone="outline">{O.kinds[s.kind]}</Badge>
              </div>
            ))}
          </div>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !ruleId} data-testid="link-series-submit">
            {t.contracts.actions.linkSeries}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
