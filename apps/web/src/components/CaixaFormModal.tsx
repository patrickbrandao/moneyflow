import { type CaixaDetail, type CaixaSummary, t } from '@moneyflow/shared';
import { CreditCard, Wallet } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';
import { type EntityOption, EntityPicker, FormError, ModalActions, MoneyInput } from './forms';
import { ImportRecipesHint } from './reconciliation/RecipesPanel';
import { Button, Field, Modal, Tabs } from './ui';

type Kind = 'general' | 'credit_card';

/** Criar ou editar uma caixa: geral ou cartão de crédito (spec 004/007). */
export function CaixaFormModal({
  open,
  caixa,
  initialHolder,
  onClose,
  onSaved,
}: {
  open: boolean;
  caixa?: CaixaDetail | null;
  initialHolder?: EntityOption | null;
  onClose: () => void;
  onSaved: (caixa: CaixaDetail) => void;
}) {
  const [kind, setKind] = useState<Kind>(caixa?.kind ?? 'general');
  const isCard = kind === 'credit_card';
  const [name, setName] = useState(caixa?.name ?? '');
  const [holder, setHolder] = useState<EntityOption | null>(
    caixa ? { id: caixa.holderEntityId, name: caixa.holderName } : (initialHolder ?? null),
  );
  const [isPrimary, setIsPrimary] = useState(caixa?.isPrimary ?? true);
  const [description, setDescription] = useState(caixa?.description ?? '');
  const card = caixa?.card;
  const [payerId, setPayerId] = useState(card?.defaultPayerCaixaId ?? '');
  const [limit, setLimit] = useState<number | null>(card?.creditLimitCents ?? null);
  const [closingDay, setClosingDay] = useState<number | ''>(card?.closingDay ?? '');
  const [dueDay, setDueDay] = useState<number | ''>(card?.dueDay ?? '');
  const [last4, setLast4] = useState(card?.cardLast4 ?? '');
  const [aiAutoReconcile, setAiAutoReconcile] = useState(card?.aiAutoReconcile ?? false);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const caixas = useApi<CaixaSummary[]>(isCard ? '/api/caixas' : null);
  const payers = (caixas.data ?? []).filter((c) => c.kind === 'general' && (!c.archivedAt || c.id === payerId));

  const validDay = (d: number | '') => typeof d === 'number' && d >= 1 && d <= 31;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!holder) return setError(isCard ? t.card.chooseIssuer : 'Escolha o titular da caixa.');
    let body: Record<string, unknown> = { name, holderEntityId: holder.id, description };
    if (isCard) {
      if (!payerId) return setError(t.card.choosePayer);
      if (limit === null || limit < 0) return setError(t.card.invalidLimit);
      if (!validDay(closingDay) || !validDay(dueDay)) return setError(t.card.invalidDay);
      if (!/^[0-9]{4}$/.test(last4)) return setError(t.card.invalidLast4);
      body = { ...body, defaultPayerCaixaId: payerId, creditLimitCents: limit, closingDay, dueDay, cardLast4: last4 };
      if (caixa) body.aiAutoReconcile = aiAutoReconcile;
    } else {
      body.isPrimary = isPrimary;
    }
    if (!caixa) body.kind = kind;
    setError(null);
    const saved = await run(
      () => (caixa ? api.patch<CaixaDetail>(`/api/caixas/${caixa.id}`, body) : api.post<CaixaDetail>('/api/caixas', body)),
      isCard ? (caixa ? t.card.updated : t.card.created) : caixa ? 'Caixa atualizada.' : 'Caixa criada.',
    );
    if (saved) onSaved(saved);
  }

  const title = caixa ? (isCard ? `${t.common.edit} ${t.caixa.kinds.credit_card?.toLowerCase()}` : 'Editar caixa') : t.palette.newCaixa;

  return (
    <Modal open={open} title={title} onClose={onClose} wide={isCard}>
      <form onSubmit={submit} className="form-grid">
        {!caixa && (
          <div>
            <span className="label">{t.card.kind}</span>
            <Tabs
              value={kind}
              onChange={(key) => setKind(key as Kind)}
              items={[
                { key: 'general', label: t.caixa.kinds.general!, icon: <Wallet /> },
                { key: 'credit_card', label: t.caixa.kinds.credit_card!, icon: <CreditCard /> },
              ]}
            />
          </div>
        )}
        <Field label={t.common.name}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={120} />
        </Field>
        <Field
          label={isCard ? t.card.issuer : t.caixa.holder}
          hint={isCard ? t.card.issuerHint : 'Pessoa ou empresa dona deste livro financeiro.'}
        >
          <EntityPicker value={holder} onChange={setHolder} ariaLabel={isCard ? t.card.issuer : t.caixa.holder} />
        </Field>
        {isCard ? (
          <div className="form-grid cols-2">
            <Field label={t.card.defaultPayer} hint={t.card.defaultPayerHint} className="span-all">
              <select className="field" value={payerId} onChange={(e) => setPayerId(e.target.value)} required>
                <option value="">Escolha…</option>
                {payers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.card.creditLimit}>
              <MoneyInput value={limit} onChange={setLimit} ariaLabel={t.card.creditLimit} />
            </Field>
            <Field label={t.card.last4} hint={t.card.last4Hint}>
              <input
                className="field field-mono"
                value={last4}
                inputMode="numeric"
                maxLength={4}
                pattern="[0-9]{4}"
                onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                required
              />
            </Field>
            <Field label={t.card.closingDay}>
              <input
                type="number"
                className="field field-mono"
                min={1}
                max={31}
                value={closingDay}
                onChange={(e) => setClosingDay(e.target.value === '' ? '' : Number(e.target.value))}
                required
              />
            </Field>
            <Field label={t.card.dueDay}>
              <input
                type="number"
                className="field field-mono"
                min={1}
                max={31}
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value === '' ? '' : Number(e.target.value))}
                required
              />
            </Field>
            {caixa && (
              <div className="span-all">
                <label className="check">
                  <input type="checkbox" checked={aiAutoReconcile} onChange={(e) => setAiAutoReconcile(e.target.checked)} />{' '}
                  {t.agentsUi.reconcile.auto}
                </label>
                <p className="hint">{t.agentsUi.reconcile.autoHint}</p>
                <ImportRecipesHint cardCaixaId={caixa.id} />
              </div>
            )}
          </div>
        ) : (
          <label className="check">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> {t.caixa.isPrimary}
          </label>
        )}
        <Field label={t.common.description}>
          <textarea className="field" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
