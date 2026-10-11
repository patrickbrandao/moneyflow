import {
  BANK_ACCOUNT_TYPES,
  type CepLookup,
  CONTACT_KINDS,
  type EntityAddress,
  type EntityBankAccount,
  type EntityContact,
  type EntityPixKey,
  guessPixKeyType,
  LINK_KINDS,
  PIX_KEY_TYPES,
  type PixKeyType,
  t,
  UFS,
} from '@moneyflow/shared';
import { Search } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { type EntityOption, EntityPicker, FormError, ModalActions } from '../forms';
import { Button, Field, Modal } from '../ui';

/*
 * Modais dos itens de uma entidade: chave PIX, contato, endereço, dado
 * bancário e vínculo. Cada um faz POST (novo) ou PUT (edição) e avisa o pai.
 */

type Props<T> = { entityId: string; item?: T | null; onClose: () => void; onSaved: () => void };

function ChildForm({
  title,
  onClose,
  onSubmit,
  busy,
  children,
  error,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <Modal open title={title} onClose={onClose}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="form-grid cols-2">{children}</div>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function useSave(entityId: string, segment: string, itemId: string | undefined, onSaved: () => void) {
  const { run, busy } = useAction();
  const save = async (body: unknown) => {
    const path = `/api/entities/${entityId}/${segment}${itemId ? `/${itemId}` : ''}`;
    const ok = await run(() => (itemId ? api.put(path, body) : api.post(path, body)), 'Salvo.');
    if (ok) onSaved();
  };
  return { save, busy };
}

export function PixKeyModal({ entityId, item, onClose, onSaved }: Props<EntityPixKey>) {
  const [keyType, setKeyType] = useState<PixKeyType>(item?.keyType ?? 'cpf');
  const [keyValue, setKeyValue] = useState(item?.keyValue ?? '');
  const [label, setLabel] = useState(item?.label ?? '');
  const [bankCode, setBankCode] = useState(item?.bankCode ?? '');
  const [isPrimary, setIsPrimary] = useState(item?.isPrimary ?? false);
  const { save, busy } = useSave(entityId, 'pix-keys', item?.id, onSaved);
  return (
    <ChildForm
      title={item ? 'Editar chave PIX' : 'Nova chave PIX'}
      onClose={onClose}
      busy={busy}
      onSubmit={() => void save({ keyType, keyValue, label, bankCode: bankCode || null, isPrimary })}
    >
      <Field label={t.common.kind}>
        <select className="field" value={keyType} onChange={(e) => setKeyType(e.target.value as PixKeyType)}>
          {PIX_KEY_TYPES.map((k) => (
            <option key={k} value={k}>
              {t.entity.pixKinds[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Chave">
        <input
          className="field field-mono"
          value={keyValue}
          required
          autoFocus
          onChange={(e) => {
            setKeyValue(e.target.value);
            const guess = guessPixKeyType(e.target.value);
            if (guess && !item) setKeyType(guess);
          }}
        />
      </Field>
      <Field label={t.entity.bank}>
        <input
          className="field field-mono"
          value={bankCode}
          onChange={(e) => setBankCode(e.target.value)}
          maxLength={3}
          placeholder="opcional"
        />
      </Field>
      <Field label={t.common.label}>
        <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="opcional" />
      </Field>
      <label className="check span-all">
        <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> {t.entity.primaryPix}
      </label>
    </ChildForm>
  );
}

export function ContactModal({ entityId, item, onClose, onSaved }: Props<EntityContact>) {
  const [kind, setKind] = useState<EntityContact['kind']>(item?.kind ?? 'phone');
  const [value, setValue] = useState(item?.value ?? '');
  const [label, setLabel] = useState(item?.label ?? '');
  const [isPrimary, setIsPrimary] = useState(item?.isPrimary ?? false);
  const { save, busy } = useSave(entityId, 'contacts', item?.id, onSaved);
  return (
    <ChildForm
      title={item ? 'Editar contato' : 'Novo contato'}
      onClose={onClose}
      busy={busy}
      onSubmit={() => void save({ kind, value, label, isPrimary })}
    >
      <Field label={t.common.kind}>
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as EntityContact['kind'])}>
          {CONTACT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t.entity.contactKinds[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={kind === 'email' ? t.user.email : kind === 'phone' ? 'Número' : 'Valor'}>
        <input className="field" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
      </Field>
      <Field label={t.common.label} className="span-all">
        <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="financeiro, celular…" />
      </Field>
      <label className="check span-all">
        <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> {t.common.primary}
      </label>
    </ChildForm>
  );
}

export function AddressModal({ entityId, item, onClose, onSaved }: Props<EntityAddress>) {
  const [form, setForm] = useState({
    label: item?.label ?? '',
    postalCode: item?.postalCode ?? '',
    street: item?.street ?? '',
    number: item?.number ?? '',
    complement: item?.complement ?? '',
    district: item?.district ?? '',
    city: item?.city ?? '',
    state: item?.state ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const { save, busy } = useSave(entityId, 'addresses', item?.id, onSaved);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function lookup() {
    setLooking(true);
    setError(null);
    try {
      const data = await api.get<CepLookup>(`/api/lookup/cep/${encodeURIComponent(form.postalCode)}`);
      setForm((f) => ({
        ...f,
        street: data.street ?? f.street,
        complement: data.complement ?? f.complement,
        district: data.district ?? f.district,
        city: data.city || f.city,
        state: data.state || f.state,
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLooking(false);
    }
  }

  return (
    <ChildForm
      title={item ? 'Editar endereço' : 'Novo endereço'}
      onClose={onClose}
      busy={busy}
      error={error}
      onSubmit={() => void save(form)}
    >
      <Field label={t.entity.postalCode}>
        <div className="flex gap-2">
          <input className="field field-mono" value={form.postalCode} onChange={set('postalCode')} placeholder="00000-000" autoFocus />
          <Button
            variant="ghost"
            onClick={() => void lookup()}
            disabled={looking || form.postalCode.replace(/\D/g, '').length !== 8}
            title={t.entity.lookupCep}
          >
            <Search />
          </Button>
        </div>
      </Field>
      <Field label={t.common.label}>
        <input className="field" value={form.label} onChange={set('label')} placeholder="sede, residência…" />
      </Field>
      <Field label={t.entity.street} className="span-all">
        <input className="field" value={form.street} onChange={set('street')} />
      </Field>
      <Field label={t.entity.number}>
        <input className="field" value={form.number} onChange={set('number')} />
      </Field>
      <Field label={t.entity.complement}>
        <input className="field" value={form.complement} onChange={set('complement')} />
      </Field>
      <Field label={t.entity.district}>
        <input className="field" value={form.district} onChange={set('district')} />
      </Field>
      <Field label={t.entity.city}>
        <input className="field" value={form.city} onChange={set('city')} required />
      </Field>
      <Field label={t.entity.state}>
        <select className="field" value={form.state} onChange={set('state')} required>
          <option value="">UF</option>
          {UFS.map((uf) => (
            <option key={uf} value={uf}>
              {uf}
            </option>
          ))}
        </select>
      </Field>
    </ChildForm>
  );
}

export function BankAccountModal({ entityId, item, onClose, onSaved }: Props<EntityBankAccount>) {
  const [form, setForm] = useState({
    bankCode: item?.bankCode ?? '',
    ispb: item?.ispb ?? '',
    branch: item?.branch ?? '',
    accountNumber: item?.accountNumber ?? '',
    accountType: item?.accountType ?? ('checking' as EntityBankAccount['accountType']),
    holderName: item?.holderName ?? '',
    label: item?.label ?? '',
  });
  const { save, busy } = useSave(entityId, 'bank-accounts', item?.id, onSaved);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <ChildForm
      title={item ? 'Editar dado bancário' : 'Novo dado bancário'}
      onClose={onClose}
      busy={busy}
      onSubmit={() => void save({ ...form, bankCode: form.bankCode || null, ispb: form.ispb || null, branch: form.branch || null })}
    >
      <Field label={t.entity.bank}>
        <input className="field field-mono" value={form.bankCode} onChange={set('bankCode')} maxLength={3} placeholder="341" autoFocus />
      </Field>
      <Field label={t.entity.ispb}>
        <input className="field field-mono" value={form.ispb} onChange={set('ispb')} maxLength={8} placeholder="opcional" />
      </Field>
      <Field label={t.entity.branch}>
        <input className="field field-mono" value={form.branch} onChange={set('branch')} />
      </Field>
      <Field label={t.entity.accountNumber}>
        <input className="field field-mono" value={form.accountNumber} onChange={set('accountNumber')} required placeholder="12345-6" />
      </Field>
      <Field label={t.common.kind}>
        <select className="field" value={form.accountType} onChange={set('accountType')}>
          {BANK_ACCOUNT_TYPES.map((k) => (
            <option key={k} value={k}>
              {t.entity.bankAccountTypes[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t.entity.holderName}>
        <input className="field" value={form.holderName} onChange={set('holderName')} placeholder="opcional" />
      </Field>
      <Field label={t.common.label} className="span-all">
        <input className="field" value={form.label} onChange={set('label')} placeholder="opcional" />
      </Field>
    </ChildForm>
  );
}

export function LinkModal({ entityId, onClose, onSaved }: Props<never>) {
  const [other, setOther] = useState<EntityOption | null>(null);
  const [kind, setKind] = useState<(typeof LINK_KINDS)[number]>('partner_of');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { save, busy } = useSave(entityId, 'links', undefined, onSaved);
  return (
    <ChildForm
      title="Novo vínculo"
      onClose={onClose}
      busy={busy}
      error={error}
      onSubmit={() => {
        if (!other) return setError('Escolha a outra entidade.');
        void save({ relatedEntityId: other.id, kind, notes });
      }}
    >
      <Field label="Esta entidade é…">
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as (typeof LINK_KINDS)[number])}>
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              {t.entity.linkKinds[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Outra entidade">
        <EntityPicker value={other} onChange={setOther} ariaLabel="Outra entidade" />
      </Field>
      <Field label={t.common.notes} className="span-all">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </ChildForm>
  );
}
