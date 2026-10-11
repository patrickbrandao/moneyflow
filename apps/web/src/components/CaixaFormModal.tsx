import { type CaixaDetail, t } from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { type EntityOption, EntityPicker, FormError, ModalActions } from './forms';
import { Button, Field, Modal } from './ui';

/** Criar ou editar uma caixa (geral; cartão chega na F2). */
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
  const [name, setName] = useState(caixa?.name ?? '');
  const [holder, setHolder] = useState<EntityOption | null>(
    caixa ? { id: caixa.holderEntityId, name: caixa.holderName } : (initialHolder ?? null),
  );
  const [isPrimary, setIsPrimary] = useState(caixa?.isPrimary ?? true);
  const [description, setDescription] = useState(caixa?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!holder) {
      setError('Escolha o titular da caixa.');
      return;
    }
    setError(null);
    const body = { name, holderEntityId: holder.id, isPrimary, description };
    const saved = await run(
      () => (caixa ? api.patch<CaixaDetail>(`/api/caixas/${caixa.id}`, body) : api.post<CaixaDetail>('/api/caixas', body)),
      caixa ? 'Caixa atualizada.' : 'Caixa criada.',
    );
    if (saved) onSaved(saved);
  }

  return (
    <Modal open={open} title={caixa ? 'Editar caixa' : t.palette.newCaixa} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={t.common.name}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={120} />
        </Field>
        <Field label={t.caixa.holder} hint="Pessoa ou empresa dona deste livro financeiro.">
          <EntityPicker value={holder} onChange={setHolder} ariaLabel={t.caixa.holder} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> {t.caixa.isPrimary}
        </label>
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
