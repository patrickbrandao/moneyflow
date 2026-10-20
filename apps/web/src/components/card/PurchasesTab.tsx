import { type CardPurchaseRow, formatDate, t } from '@moneyflow/shared';
import { Paperclip, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { purchasesTable } from '../../lib/export-tables';
import { useApi } from '../../lib/hooks';
import { entityLink } from '../../lib/links';
import { useParamState } from '../../lib/params';
import { DateRangeFilter, useStoredPeriod } from '../DateRangeFilter';
import { CategoryLabel, LoadError, Money, SkelRows } from '../domain';
import { ExportMenu } from '../ExportMenu';
import { Badge, Button, cx, EmptyRow, useDebounced } from '../ui';
import { PurchaseDrawer } from './PurchaseDrawer';
import { useGeneralCaixas, useReloadOn } from './shared';

/** Compras do cartão: filtros (período, pagadora, tipo, busca) e a gaveta da compra. */
export function PurchasesTab({
  cardCaixaId,
  cardName,
  canWrite,
  onNew,
  version,
  onChanged,
}: {
  cardCaixaId: string;
  cardName: string;
  canWrite: boolean;
  onNew: () => void;
  version: number;
  onChanged: () => void;
}) {
  const [purchaseId, setPurchaseId] = useParamState('purchase');
  const [payer, setPayer] = useParamState('payer');
  const [kind, setKind] = useParamState('kind');
  // data da compra: lembrada por cartão
  const [period, setPeriod] = useStoredPeriod(`card-purchases:${cardCaixaId}`);
  const { from, to } = period;
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const payers = useGeneralCaixas();

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (payer) params.set('payerCaixaId', payer);
  if (kind) params.set('kind', kind);
  if (query.trim()) params.set('q', query.trim());
  const { data, error, reload } = useApi<CardPurchaseRow[]>(`/api/cards/${cardCaixaId}/purchases?${params}`);
  useReloadOn(version, reload);

  const signed = (row: CardPurchaseRow) => (row.kind === 'refund' ? -row.amountCents : row.amountCents);
  const total = (data ?? []).reduce((sum, row) => sum + signed(row), 0);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="search-bar">
          <Search />
          <input
            className="field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.card.searchPurchases}
            aria-label={t.card.searchPurchases}
          />
        </label>
        <DateRangeFilter
          value={period}
          onChange={setPeriod}
          fromLabel={`${t.card.purchasedOn}: ${t.common.from}`}
          toLabel={`${t.card.purchasedOn}: ${t.common.to}`}
        />
        <select
          className="field field-auto"
          value={payer ?? ''}
          onChange={(e) => setPayer(e.target.value || null)}
          aria-label={t.card.payer}
        >
          <option value="">{t.card.allPayers}</option>
          {payers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="field field-auto"
          value={kind ?? ''}
          onChange={(e) => setKind(e.target.value || null)}
          aria-label={t.card.kindFilter}
        >
          <option value="">{t.card.allKinds}</option>
          {Object.entries(t.card.purchaseKinds).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <ExportMenu
          build={async () => {
            const all = new URLSearchParams(params);
            all.set('limit', '1000');
            return purchasesTable(await api.get<CardPurchaseRow[]>(`/api/cards/${cardCaixaId}/purchases?${all}`), cardName);
          }}
        />
        {canWrite && (
          <Button onClick={onNew}>
            <Plus /> {t.card.newPurchase}
          </Button>
        )}
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.common.date}</th>
                <th>{t.card.finalPayee}</th>
                <th>{t.card.category}</th>
                <th>{t.card.payer}</th>
                <th>{t.card.installments}</th>
                <th className="num">{t.common.amount}</th>
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={6} />}
              {data && data.length === 0 && <EmptyRow colSpan={6}>{t.card.noPurchases}</EmptyRow>}
              {data?.map((row) => (
                <tr
                  key={row.id}
                  className={cx('cursor-pointer', row.id === purchaseId && 'is-selected')}
                  onClick={() => setPurchaseId(row.id)}
                >
                  <td className="mono text-xs">{formatDate(row.purchasedOn)}</td>
                  <td>
                    <span className="row-title">
                      <Link className="link" to={entityLink(row.entityId)} onClick={(e) => e.stopPropagation()}>
                        {row.entityName}
                      </Link>
                      {row.kind !== 'purchase' && (
                        <Badge tone={row.kind === 'refund' ? 'ok' : 'warn'} className="ml-2">
                          {row.kind === 'charge' && row.chargeKind ? t.card.chargeKinds[row.chargeKind] : t.card.purchaseKinds[row.kind]}
                        </Badge>
                      )}
                      {row.attachmentCount > 0 && <Paperclip className="ml-2 inline size-3.5 text-faint" aria-label="Anexos" />}
                    </span>
                    <span className="row-sub">
                      {row.description !== row.entityName && row.description}
                      {row.refundedCents > 0 && ` · ${t.card.refunded.toLowerCase()} `}
                      {row.refundedCents > 0 && <Money cents={row.refundedCents} muted />}
                    </span>
                  </td>
                  <td>
                    <CategoryLabel name={row.categoryName} slot={row.categoryColorSlot} />
                  </td>
                  <td className="text-dim">{row.payerCaixaName}</td>
                  <td className="mono text-xs">
                    {row.installmentsTotal > 1
                      ? `${row.installmentsTotal}×${row.firstInstallment > 1 ? ` (desde ${row.firstInstallment})` : ''}`
                      : ''}
                  </td>
                  <td className="num">
                    <Money cents={signed(row)} className={cx(row.kind === 'refund' && 'in')} />
                  </td>
                </tr>
              ))}
            </tbody>
            {data && data.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={5}>
                    {data.length} lançamento{data.length === 1 ? '' : 's'}
                  </td>
                  <td className="num">
                    <Money cents={total} />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {purchaseId && (
        <PurchaseDrawer
          key={purchaseId}
          purchaseId={purchaseId}
          onClose={() => setPurchaseId(null)}
          onChanged={() => {
            void reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}
