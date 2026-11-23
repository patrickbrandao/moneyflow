import {
  type CnpjLookup,
  type EntityDetail,
  type EntityKind,
  formatDocument,
  isValidDocument,
  normalizeDocument,
  t,
} from '@moneyflow/shared';
import { Search } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction } from '../../lib/hooks';
import { FormError, ModalActions } from '../forms';
import { Button, Field, Modal } from '../ui';
import { TagPicker } from './tags';

/** Nova entidade (pessoa/empresa) ou edição; CNPJ preenche pelo CNPJ Aberto ou pela BrasilAPI (falha graciosa). */
export function EntityFormModal({
  entity,
  onClose,
  onSaved,
}: {
  entity?: EntityDetail | null;
  onClose: () => void;
  onSaved: (entity: EntityDetail) => void;
}) {
  const [kind, setKind] = useState<EntityKind>(entity?.kind ?? 'company');
  const [name, setName] = useState(entity?.name ?? '');
  const [tradeName, setTradeName] = useState(entity?.tradeName ?? '');
  const [document, setDocument] = useState(entity?.document ? formatDocument(entity.document) : '');
  const [birthDate, setBirthDate] = useState(entity?.birthDate ?? '');
  const [notes, setNotes] = useState(entity?.notes ?? '');
  const [tagIds, setTagIds] = useState<string[]>(entity?.tags.map((tag) => tag.id) ?? []);
  const user = useUser();
  const [lookedUp, setLookedUp] = useState<{ document: string; data: CnpjLookup; notice: string } | null>(null);
  const [importLookup, setImportLookup] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const { run, busy } = useAction();

  const normalized = normalizeDocument(document);
  const docInvalid = normalized !== '' && !isValidDocument(kind, normalized);
  // A consulta vale só para o CNPJ consultado (tarefa 177): trocado o documento, ou o tipo para
  // pessoa, o endereço e os contatos dela não entram na entidade nova, e o aviso some.
  const current = lookedUp && kind === 'company' && lookedUp.document === normalized ? lookedUp : null;
  const lookup = current?.data ?? null;
  const notice = current?.notice ?? null;
  const latestDocument = useRef(normalized);
  latestDocument.current = normalized;

  async function lookupCnpj() {
    const consulted = normalized;
    setLooking(true);
    setError(null);
    setLookedUp(null);
    try {
      const data = await api.get<CnpjLookup>(`/api/lookup/cnpj/${encodeURIComponent(consulted)}`);
      // Trocado o documento enquanto a consulta andava: a resposta é de outro CNPJ e não preenche nada.
      if (latestDocument.current !== consulted) return;
      setLookedUp({ document: consulted, data, notice: t.entity.lookupFilled(t.entity.lookupSources[data.source] ?? data.source) });
      if (data.name) setName(data.name);
      if (data.tradeName) setTradeName(data.tradeName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLooking(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (docInvalid) return setError(kind === 'person' ? t.errors.invalidCpf : t.errors.invalidCnpj);
    setError(null);
    const body = {
      name,
      tradeName: kind === 'company' ? tradeName : null,
      document: normalized || null,
      birthDate: kind === 'person' && birthDate ? birthDate : null,
      notes,
      tagIds,
    };
    const saved = await run(
      async () => {
        if (entity) return api.patch<EntityDetail>(`/api/entities/${entity.id}`, body);
        const created = await api.post<EntityDetail>('/api/entities', { kind, ...body });
        // Endereço e contatos vindos da consulta do CNPJ (best effort: não desfaz a entidade se falhar).
        if (lookup && importLookup) {
          const extras: Promise<unknown>[] = [];
          if (lookup.address) extras.push(api.post(`/api/entities/${created.id}/addresses`, { ...lookup.address, label: 'Sede' }));
          if (lookup.email)
            extras.push(api.post(`/api/entities/${created.id}/contacts`, { kind: 'email', value: lookup.email, isPrimary: true }));
          if (lookup.phone)
            extras.push(api.post(`/api/entities/${created.id}/contacts`, { kind: 'phone', value: lookup.phone, isPrimary: true }));
          await Promise.allSettled(extras);
          return api.get<EntityDetail>(`/api/entities/${created.id}`);
        }
        return created;
      },
      entity ? 'Entidade atualizada.' : 'Entidade criada.',
    );
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={entity ? 'Editar entidade' : t.palette.newEntity} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid cols-2">
            {!entity && (
              <div className="segmented span-all" role="group" aria-label={t.common.kind}>
                {(['company', 'person'] as const).map((k) => (
                  <button key={k} type="button" className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                    {t.entity.kinds[k]}
                  </button>
                ))}
              </div>
            )}
            <Field label={kind === 'person' ? t.entity.cpf : t.entity.cnpj} hint={kind === 'company' ? t.entity.cnpjHint : undefined}>
              <div className="flex gap-2">
                <input
                  className="field field-mono"
                  value={document}
                  // CNPJ alfanumérico: as letras ficam maiúsculas já ao digitar (spec 003).
                  onChange={(e) => setDocument(e.target.value.toUpperCase())}
                  onBlur={() => normalized && !docInvalid && setDocument(formatDocument(normalized))}
                  placeholder={kind === 'person' ? t.entity.cpfPlaceholder : t.entity.cnpjPlaceholder}
                  aria-label={kind === 'person' ? t.entity.cpf : t.entity.cnpj}
                  aria-invalid={docInvalid || undefined}
                />
                {kind === 'company' && (
                  <Button
                    variant="ghost"
                    onClick={() => void lookupCnpj()}
                    disabled={looking || normalized.length !== 14 || docInvalid}
                    title={t.entity.lookupCnpj}
                  >
                    <Search /> {looking ? '…' : t.entity.lookupCnpj}
                  </Button>
                )}
              </div>
            </Field>
            {kind === 'person' ? (
              <Field label={t.entity.birthDate}>
                <input type="date" className="field" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
              </Field>
            ) : (
              <div />
            )}
            <Field label={kind === 'company' ? t.entity.legalName : t.common.name} className="span-all">
              <input
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
                autoFocus
                aria-label={t.common.name}
              />
            </Field>
            {kind === 'company' && (
              <Field label={t.entity.tradeName} className="span-all">
                <input className="field" value={tradeName} onChange={(e) => setTradeName(e.target.value)} maxLength={200} />
              </Field>
            )}
            <Field label={t.entityTags.tags} className="span-all">
              <TagPicker value={tagIds} onChange={setTagIds} current={entity?.tags} canCreate={user.role === 'admin'} />
            </Field>
            <Field label={t.common.notes} className="span-all">
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {lookup && !entity && (lookup.address || lookup.email || lookup.phone) && (
              <label className="check span-all">
                <input type="checkbox" checked={importLookup} onChange={(e) => setImportLookup(e.target.checked)} /> Incluir endereço e
                contatos da consulta
              </label>
            )}
          </div>
          {notice && !error && <p className="notice ok mt-3">{notice}</p>}
          {lookup?.registrationStatus && lookup.registrationStatus !== 'Ativa' && !error && (
            <p className="notice warn mt-3">{t.entity.registrationStatus(lookup.registrationStatus)}</p>
          )}
          <FormError>{error}</FormError>
        </div>
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
