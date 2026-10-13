import { type DeleteResult, type EntityTag, t } from '@moneyflow/shared';
import { ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { CategoryDot } from '../domain';
import { ModalActions } from '../forms';
import { Button, Field, Modal, useConfirm } from '../ui';
import { suggestSlot, TagDot, useEntityTags } from './tags';

const NAME = t.entityTags;
const SLOTS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Gestão das tags de entidade (só admin, spec 003): lista com cor, nome e uso,
 * criar, editar, excluir (em uso = arquivar) e a seção "Arquivadas" com restaurar.
 */
export function EntityTagsModal({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const tags = useEntityTags(true);
  const [editing, setEditing] = useState<EntityTag | 'new' | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const list = tags.data ?? [];
  const active = list.filter((tag) => !tag.archivedAt);
  const archived = list.filter((tag) => tag.archivedAt);

  const changed = () => {
    void tags.reload();
    onChanged?.();
  };

  async function remove(tag: EntityTag) {
    if (!(await confirm({ title: NAME.confirmDelete(tag.name), danger: true, confirmLabel: t.common.delete }))) return;
    const result = await run(
      () => api.del<DeleteResult>(`/api/entity-tags/${tag.id}`),
      (r) => (r.archived ? NAME.archived : NAME.deleted),
    );
    if (result) changed();
  }

  async function restore(tag: EntityTag) {
    if (await run(() => api.post(`/api/entity-tags/${tag.id}/restore`), NAME.restored)) changed();
  }

  const row = (tag: EntityTag) => (
    <div key={tag.id} className={`tree-row${tag.archivedAt ? ' is-off' : ''}`} data-tag-row={tag.name}>
      <TagDot slot={tag.colorSlot} />
      <span className="nm truncate">{tag.name}</span>
      <span className="text-xs text-faint">{NAME.usage(tag.usageCount)}</span>
      {tag.archivedAt ? (
        <Button size="sm" variant="ghost" onClick={() => void restore(tag)}>
          <ArchiveRestore /> {NAME.restore}
        </Button>
      ) : (
        <>
          <button
            type="button"
            className="icon-btn"
            title={NAME.editTag}
            aria-label={`${NAME.editTag} ${tag.name}`}
            onClick={() => setEditing(tag)}
          >
            <Pencil />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t.common.delete}
            aria-label={`${t.common.delete} ${tag.name}`}
            onClick={() => void remove(tag)}
          >
            <Trash2 />
          </button>
        </>
      )}
    </div>
  );

  return (
    <Modal open title={NAME.manageTitle} onClose={onClose} wide>
      <div className="modal-body">
        <p className="mb-3 text-[13px] text-muted">{NAME.manageSub}</p>
        {tags.data && active.length === 0 && <p className="text-[13px] text-faint">{NAME.empty}</p>}
        <div className="grid gap-0.5">{active.map(row)}</div>
        {archived.length > 0 && (
          <>
            <h3 className="mt-4 mb-1 text-xs font-medium text-muted uppercase">{NAME.archivedSection}</h3>
            <div className="grid gap-0.5">{archived.map(row)}</div>
          </>
        )}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.close}
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus /> {NAME.newTag}
        </Button>
      </ModalActions>
      {editing && (
        <TagFormModal
          tag={editing === 'new' ? null : editing}
          suggested={suggestSlot(list)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
        />
      )}
    </Modal>
  );
}

function TagFormModal({
  tag,
  suggested,
  onClose,
  onSaved,
}: {
  tag: EntityTag | null;
  suggested: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tag?.name ?? '');
  const [colorSlot, setColorSlot] = useState(tag?.colorSlot ?? suggested);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = { name: name.trim(), colorSlot };
    const ok = await run(
      () => (tag ? api.patch(`/api/entity-tags/${tag.id}`, body) : api.post('/api/entity-tags', body)),
      tag ? NAME.updated : NAME.created,
    );
    if (ok) onSaved();
  }

  return (
    <Modal open title={tag ? NAME.editTag : NAME.newTag} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={NAME.name}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            maxLength={40}
            aria-label={NAME.name}
          />
        </Field>
        <Field label={NAME.color}>
          <div className="slot-picker" role="radiogroup" aria-label={NAME.color}>
            {SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                role="radio"
                aria-checked={colorSlot === slot}
                className={colorSlot === slot ? 'active' : ''}
                onClick={() => setColorSlot(slot)}
                title={NAME.colorSlot(slot)}
                aria-label={NAME.colorSlot(slot)}
              >
                <CategoryDot slot={slot} />
              </button>
            ))}
          </div>
        </Field>
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
