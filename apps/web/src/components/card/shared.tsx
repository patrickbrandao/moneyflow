import { type CaixaSummary, formatDate, type InvoiceLine, type InvoicePayerTotal, type InvoiceStatus, t } from '@moneyflow/shared';
import { CheckCheck } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { entityLink, titleLink } from '../../lib/links';
import { CategoryLabel, Money, SkelRows } from '../domain';
import { Badge, cx, EmptyRow } from '../ui';

/* Peças comuns às telas do cartão (spec 007). */

/** Competência '2026-10-01' → '10/2026'. */
export const monthLabel = (referenceMonth: string) => `${referenceMonth.slice(5, 7)}/${referenceMonth.slice(0, 4)}`;

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const tone = status === 'paid' ? 'ok' : status === 'closed' ? 'info' : 'neutral';
  return <Badge tone={tone}>{t.card.invoiceStatuses[status]}</Badge>;
}

/**
 * Caixas gerais que o usuário enxerga (candidatas a pagadora). `writable`:
 * só as em que ele pode lançar (pagar a fatura sai de uma conta delas).
 */
export function useGeneralCaixas(writable = false) {
  const { data } = useApi<CaixaSummary[]>('/api/caixas');
  return useMemo(
    () => (data ?? []).filter((c) => c.kind === 'general' && !c.archivedAt && (!writable || c.myRole === 'admin' || c.myRole === 'editor')),
    [data, writable],
  );
}

/** As linhas de uma fatura, com o rastreio até o recebedor final. */
export function InvoiceLinesTable({
  lines,
  showPayer = true,
  onOpenPurchase,
}: {
  lines: InvoiceLine[] | undefined;
  showPayer?: boolean;
  onOpenPurchase?: (purchaseId: string) => void;
}) {
  const cols = showPayer ? 7 : 6;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{t.common.date}</th>
            <th>{t.card.finalPayee}</th>
            <th>{t.card.category}</th>
            <th>{t.card.installment}</th>
            {showPayer && <th>{t.card.payer}</th>}
            <th className="num">{t.common.amount}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {!lines && <SkelRows cols={cols} />}
          {lines && lines.length === 0 && <EmptyRow colSpan={cols}>{t.card.noLines}</EmptyRow>}
          {lines?.map((line) => {
            const carry = line.itemKind === 'carryover';
            const charge = line.purchaseKind === 'charge';
            const refund = line.purchaseKind === 'refund';
            const clickable = Boolean(onOpenPurchase && line.purchaseId);
            return (
              <tr
                key={line.itemId}
                className={cx('card-line', (carry || charge) && 'is-highlight', clickable && 'cursor-pointer')}
                onClick={clickable ? () => onOpenPurchase?.(line.purchaseId!) : undefined}
              >
                <td className="mono text-xs">{line.purchasedOn ? formatDate(line.purchasedOn) : '—'}</td>
                <td>
                  {carry ? (
                    <span className="row-title">{t.card.carryover(line.carriedFromMonth ? monthLabel(line.carriedFromMonth) : null)}</span>
                  ) : (
                    <>
                      <span className="row-title">
                        {line.entityId ? (
                          <Link className="link" to={entityLink(line.entityId)} onClick={(e) => e.stopPropagation()}>
                            {line.entityName}
                          </Link>
                        ) : (
                          line.entityName
                        )}
                        {(refund || charge) && (
                          <Badge tone={refund ? 'ok' : 'warn'} className="ml-2">
                            {charge && line.chargeKind ? t.card.chargeKinds[line.chargeKind] : t.card.purchaseKinds[line.purchaseKind!]}
                          </Badge>
                        )}
                      </span>
                      {line.description &&
                        line.description !== line.entityName &&
                        line.description !== (line.chargeKind ? t.card.chargeKinds[line.chargeKind] : null) && (
                          <span className="row-sub">{line.description}</span>
                        )}
                    </>
                  )}
                </td>
                <td>{line.categoryName ? <CategoryLabel name={line.categoryName} slot={line.categoryColorSlot} /> : '—'}</td>
                <td className="mono text-xs">{t.card.installmentOf(line.installmentNumber, line.installmentsTotal)}</td>
                {showPayer && <td className="text-dim">{line.payerCaixaName}</td>}
                <td className="num">
                  <Money cents={line.amountCents} className={cx(line.amountCents < 0 && 'in')} />
                </td>
                <td className="text-right">
                  {line.reconciled && (
                    <span className="text-faint" title={t.card.reconciled} role="img" aria-label={t.card.reconciled}>
                      <CheckCheck className="size-4" />
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        {lines && lines.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={cols - 2}>
                {lines.length} lançamento{lines.length === 1 ? '' : 's'}
              </td>
              <td className="num">
                <Money cents={lines.reduce((sum, l) => sum + l.amountCents, 0)} />
              </td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Totais por pagadora, com o link para o título "a pagar" de cada uma (quando legível). */
export function PayerTotalsTable({ payers, actions }: { payers: InvoicePayerTotal[]; actions?: (payer: InvoicePayerTotal) => ReactNode }) {
  if (payers.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{t.card.payer}</th>
            <th className="num">{t.card.total}</th>
            <th className="num">{t.card.paid}</th>
            <th className="num">{t.card.open}</th>
            <th className="num">{t.card.carried}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {payers.map((p) => (
            <tr key={p.payerCaixaId}>
              <td>
                <span className="row-title">{p.payerCaixaName}</span>
                {p.payerTitleId && p.canReadPayer && (
                  <span className="row-sub">
                    <Link className="link" to={titleLink({ id: p.payerTitleId, caixaId: p.payerCaixaId, direction: 'payable' })}>
                      {t.card.seeTitle}
                    </Link>
                  </span>
                )}
              </td>
              <td className="num">
                <Money cents={p.itemsCents} />
              </td>
              <td className="num">
                <Money cents={p.settledCents} muted={p.settledCents === 0} />
              </td>
              <td className="num">
                <Money cents={p.openCents} muted={p.openCents === 0} />
              </td>
              <td className="num">
                <Money cents={p.carriedOutCents} muted={p.carriedOutCents === 0} />
              </td>
              <td className="text-right">{actions?.(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Recarrega quando `version` muda (depois de uma escrita feita fora do componente). */
export function useReloadOn(version: number, reload: () => Promise<void>) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void reload();
  }, [version]);
}
