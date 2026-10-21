import { type CardChargeSuggestion, type CardPurchaseDetail, formatAccounting, formatDate, formatMonth, t } from '@moneyflow/shared';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { ModalActions } from '../forms';
import { Button, Modal, useDebounced } from '../ui';

/*
 * Cobrança esperada no cartão (spec 034): uma compra pode atender uma
 * ocorrência de uma série no cartão (a obrigação de um contrato). A lista vem
 * de GET /api/cards/:id/expected-charges pela data e, se houver, pelo valor.
 */

const PL = t.contracts.planned;

export type ChargeRef = { ruleId: string; occurrence: number };

export const chargeKey = (c: ChargeRef) => `${c.ruleId}:${c.occurrence}`;

/** "<obrigação> de <mês>". */
export const chargeLabel = (c: Pick<CardChargeSuggestion, 'contractName' | 'description' | 'dueDate'>) =>
  `${c.contractName ?? c.description} · ${formatMonth(c.dueDate)}`;

export function useExpectedCharges(cardCaixaId: string, date: string, amountCents: number | null, enabled = true) {
  const [rows, setRows] = useState<CardChargeSuggestion[] | null>(null);
  const key = useDebounced(enabled && date ? `${date}|${amountCents ?? ''}` : '', 250);
  useEffect(() => {
    if (!key) {
      setRows(null);
      return;
    }
    const [d, amount] = key.split('|');
    let cancelled = false;
    api
      .get<CardChargeSuggestion[]>(`/api/cards/${cardCaixaId}/expected-charges`, { date: d, amountCents: amount || undefined })
      .then((r) => !cancelled && setRows(r))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [key, cardCaixaId]);
  return rows;
}

/** Lista das ocorrências esperadas para escolher uma (ou nenhuma). */
export function ChargeChoices({
  rows,
  value,
  onChange,
}: {
  rows: CardChargeSuggestion[] | null;
  value: string | null;
  onChange: (charge: ChargeRef | null) => void;
}) {
  if (rows === null) return <p className="text-[13px] text-muted">{t.common.loading}</p>;
  if (rows.length === 0) return <p className="notice info">{PL.chargeNone}</p>;
  return (
    <div className="rec-cands" role="radiogroup" aria-label={PL.isChargeOf} data-testid="card-charge-choices">
      <label className="rec-radio">
        <input type="radio" name="card-charge" checked={value === null} onChange={() => onChange(null)} />
        <span className="min-w-0 flex-1 text-[13px]">{PL.chargeLoose}</span>
      </label>
      {rows.map((c) => (
        <label key={chargeKey(c)} className="rec-radio" data-testid="card-charge-choice">
          <input
            type="radio"
            name="card-charge"
            checked={value === chargeKey(c)}
            onChange={() => onChange({ ruleId: c.ruleId, occurrence: c.occurrence })}
          />
          <span className="mono w-[84px] text-xs">{formatDate(c.dueDate)}</span>
          <span className="min-w-0 flex-1">
            <span className="row-title">{chargeLabel(c)}</span>
            <span className="row-sub">
              {c.contractName ? c.description : ''}
              {c.entityName ? `${c.contractName ? ' · ' : ''}${c.entityName}` : ''}
            </span>
          </span>
          <span className="mono text-[13px]">{formatAccounting(c.expectedCents)}</span>
        </label>
      ))}
    </div>
  );
}

/** Ligar a compra a uma ocorrência esperada (POST /api/card-purchases/:id/charge-link). */
export function ChargeLinkModal({
  purchase,
  onClose,
  onSaved,
}: {
  purchase: CardPurchaseDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const rows = useExpectedCharges(purchase.cardCaixaId, purchase.purchasedOn, purchase.amountCents);
  const [chosen, setChosen] = useState<ChargeRef | null>(null);
  const { run, busy } = useAction();

  async function submit() {
    if (!chosen) return;
    const ok = await run(() => api.post(`/api/card-purchases/${purchase.id}/charge-link`, { charge: chosen }), PL.chargeLinked);
    if (ok) onSaved();
  }

  return (
    <Modal open title={PL.chargeLinkTitle} onClose={onClose} wide>
      <div className="modal-body">
        <ChargeChoices rows={rows} value={chosen ? chargeKey(chosen) : null} onChange={setChosen} />
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button onClick={() => void submit()} disabled={!chosen || busy}>
          {PL.chargeLink}
        </Button>
      </ModalActions>
    </Modal>
  );
}
