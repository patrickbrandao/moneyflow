import { type AccountRow, type CaixaSummary, formatAccounting, formatDate, type TransferRow, t, todayIso } from '@moneyflow/shared';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadError, Money, PageHead, SkelRows } from '../components/domain';
import { FormError, ModalActions, MoneyInput } from '../components/forms';
import { Badge, Button, EmptyRow, Field, Modal, useConfirm } from '../components/ui';
import { canWriteCaixa } from '../lib/access';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

/** Transferências entre contas (spec 005): par de movimentos que soma zero; não é receita nem despesa. */
export function TransfersPage() {
  const user = useUser();
  const [isNew, setNew] = useParamState('new');
  const [caixaId, setCaixaId] = useParamState('caixa');
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const { data, error, reload } = useApi<TransferRow[]>(`/api/transfers${caixaId ? `?caixaId=${caixaId}` : ''}`);
  const confirm = useConfirm();
  const { run } = useAction();

  useRegisterCommands([{ id: 'transfer-new', label: t.palette.newTransfer, group: 'Criar', icon: <Plus />, run: () => setNew('1') }], []);

  async function remove(row: TransferRow) {
    const ok = await confirm({
      title: 'Excluir a transferência?',
      description: `${formatAccounting(row.amountCents)} de ${row.fromAccountName} para ${row.toAccountName}. Os dois movimentos saem dos extratos.`,
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (ok && (await run(() => api.del(`/api/transfers/${row.id}`), 'Transferência excluída.'))) void reload();
  }

  return (
    <div className="page wide">
      <PageHead
        title={t.nav.transfers}
        sub="Dinheiro que muda de conta, dentro da mesma caixa ou entre caixas."
        actions={
          <>
            <select
              className="field field-auto"
              value={caixaId ?? ''}
              onChange={(e) => setCaixaId(e.target.value || null)}
              aria-label="Caixa"
            >
              <option value="">Todas as caixas</option>
              {(caixas.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button onClick={() => setNew('1')}>
              <Plus /> {t.palette.newTransfer}
            </Button>
          </>
        }
      />
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.common.date}</th>
                <th>{t.transfer.from}</th>
                <th />
                <th>{t.transfer.to}</th>
                <th>{t.common.description}</th>
                <th className="num">{t.common.amount}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={7} />}
              {data && data.length === 0 && <EmptyRow colSpan={7}>Nenhuma transferência.</EmptyRow>}
              {data?.map((row) => (
                <tr key={row.id}>
                  <td className="mono text-xs">{formatDate(row.transferredOn)}</td>
                  <td>
                    <span className="row-title">{row.fromAccountName}</span>
                    <Link
                      to={`/caixas/${row.fromCaixaId}/statement?account=${row.fromAccountId}`}
                      className="row-sub hover:text-[var(--accent-soft)]"
                    >
                      {row.fromCaixaName}
                    </Link>
                  </td>
                  <td className="text-faint">
                    <ArrowRight className="size-4" />
                  </td>
                  <td>
                    <span className="row-title">{row.toAccountName}</span>
                    <Link
                      to={`/caixas/${row.toCaixaId}/statement?account=${row.toAccountId}`}
                      className="row-sub hover:text-[var(--accent-soft)]"
                    >
                      {row.toCaixaName}
                    </Link>
                  </td>
                  <td className="text-dim">
                    {row.description ?? '—'} {row.settlementId && <Badge tone="outline">{t.transfer.fromSettlement}</Badge>}
                  </td>
                  <td className="num">
                    <Money cents={row.amountCents} />
                  </td>
                  <td className="text-right">
                    {!row.settlementId && canWriteCaixa(user, row.fromCaixaId) && canWriteCaixa(user, row.toCaixaId) && (
                      <button type="button" className="row-action danger" title={t.common.delete} onClick={() => void remove(row)}>
                        <Trash2 />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isNew && (
        <TransferModal
          onClose={() => setNew(null)}
          onSaved={() => {
            setNew(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

export function TransferModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const accounts = useApi<AccountRow[]>('/api/accounts?writable=1');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const list = accounts.data ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!amount || amount <= 0) return setError(t.errors.invalidAmount);
    if (fromId === toId) return setError('Escolha contas diferentes.');
    setError(null);
    const ok = await run(
      () => api.post('/api/transfers', { fromAccountId: fromId, toAccountId: toId, amountCents: amount, transferredOn: date, description }),
      'Transferência registrada.',
    );
    if (ok) onSaved();
  }

  const options = (exclude: string) =>
    list
      .filter((a) => a.id !== exclude)
      .map((a) => (
        <option key={a.id} value={a.id}>
          {a.caixaName} › {a.name} · {formatAccounting(a.balanceCents)}
        </option>
      ));

  return (
    <Modal open title={t.palette.newTransfer} onClose={onClose}>
      <form onSubmit={submit} className="form-grid cols-2">
        <Field label={t.transfer.from} className="span-all">
          <select
            className="field"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            required
            autoFocus
            aria-label={t.transfer.from}
          >
            <option value="">{accounts.loading ? t.common.loading : 'Escolha…'}</option>
            {options(toId)}
          </select>
        </Field>
        <Field label={t.transfer.to} className="span-all">
          <select className="field" value={toId} onChange={(e) => setToId(e.target.value)} required aria-label={t.transfer.to}>
            <option value="">{accounts.loading ? t.common.loading : 'Escolha…'}</option>
            {options(fromId)}
          </select>
        </Field>
        <Field label={t.common.amount}>
          <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.common.amount} />
        </Field>
        <Field label={t.transfer.date}>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label={t.common.description} className="span-all">
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="opcional" />
        </Field>
        <div className="span-all">
          <FormError>{error}</FormError>
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={busy || !fromId || !toId}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </ModalActions>
        </div>
      </form>
    </Modal>
  );
}
