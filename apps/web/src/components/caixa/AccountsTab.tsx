import { ACCOUNT_KINDS, type AccountRow, type CaixaDetail, formatDate, t, todayIso } from '@moneyflow/shared';
import { Archive, ArchiveRestore, FileText, Pencil, Plus, PlusCircle } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction } from '../../lib/hooks';
import { caixaTab } from '../../lib/links';
import { Money } from '../domain';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { Badge, Button, EmptyRow, Field, Modal, useConfirm } from '../ui';

type Kind = (typeof ACCOUNT_KINDS)[number];

/** Contas financeiras da caixa (spec 004): corrente, cofre e poupança/investimento, com saldo. */
export function AccountsTab({ caixa, onChanged }: { caixa: CaixaDetail; onChanged: () => void }) {
  const [editing, setEditing] = useState<AccountRow | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<AccountRow | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();

  useRegisterCommands(
    caixa.canWrite
      ? [
          {
            id: 'account-new',
            label: `${t.palette.newAccount} em ${caixa.name}`,
            group: 'Criar',
            icon: <Plus />,
            run: () => setEditing('new'),
          },
        ]
      : [],
    [caixa.canWrite, caixa.id],
  );

  async function archive(account: AccountRow) {
    const ok = await confirm({
      title: `Excluir a conta ${account.name}?`,
      description: 'Sem movimentos ela é excluída; com histórico, é arquivada (some das listas e continua nos relatórios).',
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () => api.del<{ archived: boolean }>(`/api/accounts/${account.id}`),
      (r) => t.common.deletedOrArchived(r.archived),
    );
    if (result) onChanged();
  }

  async function restore(account: AccountRow) {
    if (await run(() => api.post(`/api/accounts/${account.id}/restore`), 'Conta restaurada.')) onChanged();
  }

  const total = caixa.accounts.filter((a) => !a.archivedAt).reduce((sum, a) => sum + a.balanceCents, 0);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[13px] text-muted">
          {t.caixa.balance}: <Money cents={total} />
        </p>
        {caixa.canWrite && (
          <Button onClick={() => setEditing('new')}>
            <Plus /> {t.palette.newAccount}
          </Button>
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Conta</th>
              <th>{t.common.kind}</th>
              <th>Banco</th>
              <th className="num">{t.caixa.openingBalance}</th>
              <th className="num">{t.common.balance}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {caixa.accounts.length === 0 && <EmptyRow colSpan={6}>Nenhuma conta nesta caixa.</EmptyRow>}
            {caixa.accounts.map((account) => (
              <tr key={account.id} className={account.archivedAt ? 'is-off' : ''}>
                <td>
                  <Link
                    to={`${caixaTab(caixa.id, 'statement')}?account=${account.id}`}
                    className="row-title hover:text-[var(--accent-soft)]"
                  >
                    {account.name}
                  </Link>
                  {account.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
                </td>
                <td className="text-dim">{t.caixa.accountKinds[account.kind]}</td>
                <td className="mono text-xs text-dim">
                  {[account.bankCode, account.branch, account.accountNumber].filter(Boolean).join(' · ') || '—'}
                </td>
                <td className="num">
                  <Money cents={account.openingBalanceCents} muted />
                  <span className="row-sub">{formatDate(account.openingDate)}</span>
                </td>
                <td className="num">
                  <Money cents={account.balanceCents} />
                </td>
                <td className="text-right">
                  <span className="row-actions">
                    <Link className="row-action" title={t.caixa.statement} to={`${caixaTab(caixa.id, 'statement')}?account=${account.id}`}>
                      <FileText />
                    </Link>
                    {caixa.canWrite && !account.archivedAt && (
                      <>
                        <button type="button" className="row-action" title={t.caixa.adjustment} onClick={() => setAdjusting(account)}>
                          <PlusCircle />
                        </button>
                        <button type="button" className="row-action" title={t.common.edit} onClick={() => setEditing(account)}>
                          <Pencil />
                        </button>
                        <button type="button" className="row-action danger" title={t.common.delete} onClick={() => void archive(account)}>
                          <Archive />
                        </button>
                      </>
                    )}
                    {caixa.canWrite && account.archivedAt && (
                      <button type="button" className="row-action" title={t.common.restore} onClick={() => void restore(account)}>
                        <ArchiveRestore />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <AccountFormModal
          caixaId={caixa.id}
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
      {adjusting && (
        <AdjustmentModal
          account={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function AccountFormModal({
  caixaId,
  account,
  onClose,
  onSaved,
}: {
  caixaId: string;
  account: AccountRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<Kind>(account?.kind ?? 'checking');
  const [name, setName] = useState(account?.name ?? '');
  const [bankCode, setBankCode] = useState(account?.bankCode ?? '');
  const [branch, setBranch] = useState(account?.branch ?? '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '');
  const [opening, setOpening] = useState<number | null>(account?.openingBalanceCents ?? 0);
  const [openingDate, setOpeningDate] = useState(account?.openingDate ?? todayIso());
  const [aiAutoReconcile, setAiAutoReconcile] = useState(account?.aiAutoReconcile ?? false);
  // "Conciliar com IA ao importar" (spec 029): só conta corrente e poupança, na edição.
  const reconciles = Boolean(account) && (kind === 'checking' || kind === 'savings');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const bank = kind !== 'cash';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (opening === null) return setError(t.errors.invalidAmount);
    setError(null);
    const body = {
      name,
      openingBalanceCents: opening,
      openingDate,
      ...(bank ? { bankCode: bankCode || null, branch: branch || null, accountNumber: accountNumber || null } : {}),
      ...(reconciles ? { aiAutoReconcile } : {}),
    };
    const saved = await run(
      () => (account ? api.patch(`/api/accounts/${account.id}`, body) : api.post(`/api/caixas/${caixaId}/accounts`, { ...body, kind })),
      account ? 'Conta atualizada.' : 'Conta criada.',
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={account ? 'Editar conta' : t.palette.newAccount} onClose={onClose}>
      <form onSubmit={submit} className="form-grid cols-2">
        <Field label={t.common.kind} className="span-all">
          <select className="field" value={kind} disabled={Boolean(account)} onChange={(e) => setKind(e.target.value as Kind)}>
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t.caixa.accountKinds[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.common.name} className="span-all">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={120} />
        </Field>
        {bank && (
          <>
            <Field label={t.entity.bank}>
              <input
                className="field field-mono"
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
                placeholder="077"
                maxLength={3}
              />
            </Field>
            <Field label={t.entity.branch}>
              <input className="field field-mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="0001" />
            </Field>
            <Field label={t.entity.accountNumber} className="span-all">
              <input
                className="field field-mono"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                placeholder="12345-6"
              />
            </Field>
          </>
        )}
        <Field label={t.caixa.openingBalance}>
          <MoneyInput value={opening} onChange={setOpening} allowNegative={kind !== 'cash'} ariaLabel={t.caixa.openingBalance} />
        </Field>
        <Field label={t.caixa.openingDate}>
          <input type="date" className="field" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} required />
        </Field>
        {reconciles && (
          <div className="span-all">
            <label className="check">
              <input type="checkbox" checked={aiAutoReconcile} onChange={(e) => setAiAutoReconcile(e.target.checked)} />{' '}
              {t.agentsUi.reconcile.auto}
            </label>
            <p className="hint">{t.agentsUi.reconcile.autoHint}</p>
          </div>
        )}
        <div className="span-all">
          <FormError>{error}</FormError>
        </div>
        <div className="span-all">
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </ModalActions>
        </div>
      </form>
    </Modal>
  );
}

/** Lançamento avulso (ajuste de contagem, rendimento, tarifa): + entra, − sai. */
function AdjustmentModal({ account, onClose, onSaved }: { account: AccountRow; onClose: () => void; onSaved: () => void }) {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState<number | null>(null);
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!amount) return;
    const saved = await run(
      () =>
        api.post(`/api/accounts/${account.id}/adjustments`, {
          occurredOn,
          amountCents: direction === 'in' ? amount : -amount,
          description,
          categoryId,
        }),
      'Lançamento registrado.',
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={`${t.caixa.adjustment} · ${account.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid cols-2">
        <div className="segmented span-all" role="group">
          <button type="button" className={direction === 'in' ? 'active' : ''} onClick={() => setDirection('in')}>
            Entrada
          </button>
          <button type="button" className={direction === 'out' ? 'active' : ''} onClick={() => setDirection('out')}>
            Saída
          </button>
        </div>
        <Field label={t.common.amount}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus ariaLabel={t.common.amount} />
        </Field>
        <Field label={t.common.date}>
          <input type="date" className="field" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} required />
        </Field>
        <Field label={t.common.description} className="span-all">
          <input
            className="field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            placeholder="Rendimento, tarifa, ajuste de contagem…"
          />
        </Field>
        <Field label={`${t.title.category} (${t.common.optional})`} className="span-all">
          <CategorySelect
            kind={direction === 'in' ? 'income' : 'expense'}
            caixaId={account.caixaId}
            value={categoryId}
            onChange={setCategoryId}
            allowEmpty={t.common.none}
          />
        </Field>
        <div className="span-all">
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={busy || !amount || !description.trim()}>
              {t.common.save}
            </Button>
          </ModalActions>
        </div>
      </form>
    </Modal>
  );
}
