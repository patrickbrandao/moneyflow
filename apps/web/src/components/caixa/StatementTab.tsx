import { addDays, type CaixaDetail, formatDate, type Statement, t, todayIso } from '@moneyflow/shared';
import { ExternalLink, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { statementTable } from '../../lib/export-tables';
import { useAction, useApi } from '../../lib/hooks';
import { accountLink, titleLink } from '../../lib/links';
import { useParamState } from '../../lib/params';
import { AttachmentsModal } from '../attachments/AttachmentsPanel';
import { LoadError, Money, SkelRows } from '../domain';
import { ExportMenu } from '../ExportMenu';
import { Badge, EmptyRow, EmptyState, useConfirm } from '../ui';

/**
 * Extrato por conta: movimentos do período com saldo corrente. Na caixa, escolhe a conta;
 * na tela da conta (`fixedAccountId`), fica nela, sem o seletor.
 */
export function StatementTab({ caixa, fixedAccountId, onChanged }: { caixa: CaixaDetail; fixedAccountId?: string; onChanged: () => void }) {
  const active = caixa.accounts.filter((a) => !a.archivedAt);
  const [accountParam, setAccount] = useParamState('account');
  const accountId = fixedAccountId ?? accountParam ?? active[0]?.id ?? caixa.accounts[0]?.id ?? null;
  const [from, setFrom] = useState(addDays(todayIso(), -30));
  const [to, setTo] = useState('');
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const { data, error, reload } = useApi<Statement>(accountId ? `/api/accounts/${accountId}/statement?${qs}` : null);
  const confirm = useConfirm();
  const [attachFor, setAttachFor] = useState<{ id: string; label: string } | null>(null);
  const { run } = useAction();

  if (!accountId) {
    return (
      <EmptyState icon={<FileText />} title="Nenhuma conta nesta caixa" description="Crie uma conta na aba Contas para ver o extrato." />
    );
  }

  async function removeAdjustment(id: string) {
    const ok = await confirm({ title: 'Excluir o lançamento avulso?', confirmLabel: t.common.delete, danger: true });
    if (!ok) return;
    if (await run(() => api.del(`/api/movements/${id}`), 'Lançamento excluído.')) {
      void reload();
      onChanged();
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!fixedAccountId && (
          <>
            <select
              className="field field-auto"
              value={accountId}
              onChange={(e) => setAccount(e.target.value)}
              aria-label={t.settlement.account}
            >
              {caixa.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.archivedAt ? ` (${t.common.archived.toLowerCase()})` : ''}
                </option>
              ))}
            </select>
            <Link className="row-action" to={accountLink(caixa.id, accountId, 'statement')} title={t.caixa.account.open}>
              <ExternalLink />
            </Link>
          </>
        )}
        <input
          type="date"
          className="field field-auto"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label={t.common.from}
          title={t.common.from}
        />
        <input
          type="date"
          className="field field-auto"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label={t.common.to}
          title={t.common.to}
        />
        <span className="flex-1" />
        <ExportMenu disabled={!data} build={() => statementTable(data!, caixa.name)} />
        {data && (
          <span className="text-[13px] text-muted">
            {t.statement.opening}: <Money cents={data.openingCents} /> · {t.statement.closing}: <Money cents={data.closingCents} />
          </span>
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
                <th>Lançamento</th>
                <th>{t.common.kind}</th>
                <th className="num">{t.common.amount}</th>
                <th className="num">{t.common.balance}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={6} />}
              {data && (
                <tr>
                  <td className="mono text-xs text-faint">{data.from ? formatDate(addDays(data.from, -1)) : '—'}</td>
                  <td className="text-muted" colSpan={3}>
                    {t.statement.opening}
                  </td>
                  <td className="num">
                    <Money cents={data.openingCents} />
                  </td>
                  <td />
                </tr>
              )}
              {data && data.rows.length === 0 && <EmptyRow colSpan={6}>Nenhum movimento no período.</EmptyRow>}
              {data?.rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono text-xs">{formatDate(row.occurredOn)}</td>
                  <td>
                    {row.titleId ? (
                      <Link
                        to={titleLink({
                          id: row.titleId,
                          caixaId: caixa.id,
                          direction: row.amountCents < 0 !== row.isReversal ? 'payable' : 'receivable',
                        })}
                        className="row-title hover:text-[var(--accent-soft)]"
                      >
                        {row.titleDescription ?? row.description}
                      </Link>
                    ) : (
                      <span className="row-title">{row.description ?? '—'}</span>
                    )}
                    <span className="row-sub">
                      {[
                        row.entityName,
                        row.categoryName,
                        row.counterpartAccountName &&
                          `${row.amountCents < 0 ? '→' : '←'} ${row.counterpartCaixaName} › ${row.counterpartAccountName}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </td>
                  <td>
                    <span className="inline-flex gap-1">
                      <Badge tone="outline">{t.statement.movementKinds[row.kind]}</Badge>
                      {row.isReversal && <Badge tone="danger">{t.statement.reversal}</Badge>}
                    </span>
                  </td>
                  <td className="num">
                    <Money cents={row.amountCents} signed />
                  </td>
                  <td className="num">
                    <Money cents={row.balanceCents} />
                  </td>
                  <td className="text-right">
                    <span className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title={t.attachments.movementTitle}
                        aria-label={t.attachments.movementTitle}
                        onClick={() =>
                          setAttachFor({ id: row.id, label: row.titleDescription ?? row.description ?? formatDate(row.occurredOn) })
                        }
                      >
                        <Paperclip />
                      </button>
                      {row.kind === 'adjustment' && caixa.canWrite && (
                        <button
                          type="button"
                          className="row-action danger"
                          title={t.common.delete}
                          onClick={() => void removeAdjustment(row.id)}
                        >
                          <Trash2 />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {attachFor && (
        <AttachmentsModal
          target="movement"
          targetId={attachFor.id}
          canWrite={caixa.canWrite}
          title={`${t.attachments.movementTitle}: ${attachFor.label}`}
          onClose={() => setAttachFor(null)}
        />
      )}
    </>
  );
}
