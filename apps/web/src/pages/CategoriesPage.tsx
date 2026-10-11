import { CATEGORY_KINDS, type CaixaSummary, type CategoryNode, t } from '@moneyflow/shared';
import { Archive, ArchiveRestore, Eye, EyeOff, Pencil, Plus, Tags } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { CategoryDot, LoadError, PageHead } from '../components/domain';
import { FormError, ModalActions } from '../components/forms';
import { Badge, Button, cx, Field, Modal, Panel, Skel, useConfirm } from '../components/ui';
import { canWriteCaixa } from '../lib/access';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

type Kind = (typeof CATEGORY_KINDS)[number];
const SLOTS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Plano global de categorias (spec 008): receita e despesa, grupo → subcategoria,
 * com cor (slot 1–12 → --port-N) e ícone. Só o admin altera o plano; quem
 * edita uma caixa escolhe as categorias que ela oculta.
 */
export function CategoriesPage() {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [caixaId, setCaixaId] = useParamState('caixa');
  const [showArchived, setShowArchived] = useState(false);
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const qs = new URLSearchParams();
  if (caixaId) qs.set('caixaId', caixaId);
  if (showArchived) qs.set('archived', '1');
  const tree = useApi<CategoryNode[]>(`/api/categories?${qs}`);
  const hidden = useApi<string[]>(caixaId ? `/api/caixas/${caixaId}/hidden-categories` : null);
  const [editing, setEditing] = useState<{ kind: Kind; node?: CategoryNode; parentId?: string | null } | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const canHide = Boolean(caixaId && canWriteCaixa(user, caixaId));

  useRegisterCommands(
    isAdmin
      ? CATEGORY_KINDS.map((kind) => ({
          id: `category-new-${kind}`,
          label: `${t.palette.newCategory} de ${t.category.kinds[kind]!.toLowerCase()}`,
          group: 'Criar' as const,
          icon: <Plus />,
          run: () => setEditing({ kind, parentId: null }),
        }))
      : [],
    [isAdmin],
  );

  async function toggleHidden(node: CategoryNode) {
    if (!caixaId || !hidden.data) return;
    const set = new Set(hidden.data);
    if (set.has(node.id)) set.delete(node.id);
    else set.add(node.id);
    const next = await run(() => api.put<string[]>(`/api/caixas/${caixaId}/hidden-categories`, { categoryIds: [...set] }));
    if (next) {
      hidden.setData(next);
      void tree.reload();
    }
  }

  async function archive(node: CategoryNode) {
    const ok = await confirm({
      title: `Excluir a categoria ${node.name}?`,
      description: 'Sem uso ela é excluída; usada em títulos, é arquivada (com as subcategorias).',
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (!ok) return;
    if (
      await run(
        () => api.del<{ archived: boolean }>(`/api/categories/${node.id}`),
        (r) => t.common.deletedOrArchived(r.archived),
      )
    )
      void tree.reload();
  }

  async function restore(node: CategoryNode) {
    if (await run(() => api.post(`/api/categories/${node.id}/restore`), 'Categoria restaurada.')) void tree.reload();
  }

  const explicit = new Set(hidden.data ?? []);
  const row = (node: CategoryNode, child: boolean) => (
    <div key={node.id} className={cx('tree-row', child && 'child', (node.archivedAt || node.hidden) && 'is-off')}>
      <CategoryDot slot={node.colorSlot} />
      <span className="nm truncate">
        {node.name}
        {node.icon && <span className="mono ml-2 text-[11px] text-faint">{node.icon}</span>}
      </span>
      {node.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
      {node.hidden && <Badge tone="outline">{t.category.hidden}</Badge>}
      <span className="row-actions">
        {canHide && !node.archivedAt && (!node.hidden || explicit.has(node.id)) && (
          <button
            type="button"
            className="row-action"
            title={node.hidden ? 'Mostrar nesta caixa' : 'Ocultar nesta caixa'}
            onClick={() => void toggleHidden(node)}
          >
            {node.hidden ? <Eye /> : <EyeOff />}
          </button>
        )}
        {isAdmin && !child && !node.archivedAt && (
          <button
            type="button"
            className="row-action"
            title={`Nova ${t.category.subcategory.toLowerCase()}`}
            onClick={() => setEditing({ kind: node.kind, parentId: node.id })}
          >
            <Plus />
          </button>
        )}
        {isAdmin && !node.archivedAt && (
          <>
            <button type="button" className="row-action" title={t.common.edit} onClick={() => setEditing({ kind: node.kind, node })}>
              <Pencil />
            </button>
            <button type="button" className="row-action danger" title={t.common.delete} onClick={() => void archive(node)}>
              <Archive />
            </button>
          </>
        )}
        {isAdmin && node.archivedAt && (
          <button type="button" className="row-action" title={t.common.restore} onClick={() => void restore(node)}>
            <ArchiveRestore />
          </button>
        )}
      </span>
    </div>
  );

  return (
    <div className="page wide">
      <PageHead
        title={t.nav.categories}
        sub="Plano único para todas as caixas, em dois níveis. Cada caixa pode ocultar o que não usa."
        actions={
          <>
            <select
              className="field field-auto"
              value={caixaId ?? ''}
              onChange={(e) => setCaixaId(e.target.value || null)}
              aria-label="Caixa"
            >
              <option value="">Todas as caixas (plano global)</option>
              {(caixas.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  Ocultas em: {c.name}
                </option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t.common.showArchived}
            </label>
          </>
        }
      />
      {tree.error ? (
        <LoadError error={tree.error} onRetry={() => void tree.reload()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(['expense', 'income'] as const).map((kind) => {
            const groups = (tree.data ?? []).filter((n) => n.kind === kind);
            return (
              <Panel
                key={kind}
                title={kind === 'expense' ? 'Despesas' : 'Receitas'}
                icon={<Tags />}
                actions={
                  isAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ kind, parentId: null })}>
                      <Plus /> {t.category.group}
                    </Button>
                  )
                }
              >
                {!tree.data && <Skel h={120} />}
                {tree.data && groups.length === 0 && <p className="text-[13px] text-faint">Nenhuma categoria.</p>}
                <div className="grid gap-0.5">{groups.map((group) => [row(group, false), ...group.children.map((c) => row(c, true))])}</div>
              </Panel>
            );
          })}
        </div>
      )}
      {editing && (
        <CategoryModal
          kind={editing.kind}
          node={editing.node}
          parentId={editing.parentId ?? null}
          groups={(tree.data ?? []).filter((n) => n.kind === editing.kind && !n.archivedAt)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void tree.reload();
          }}
        />
      )}
    </div>
  );
}

function CategoryModal({
  kind,
  node,
  parentId: initialParent,
  groups,
  onClose,
  onSaved,
}: {
  kind: Kind;
  node?: CategoryNode;
  parentId: string | null;
  groups: CategoryNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(node?.name ?? '');
  const [parentId, setParentId] = useState<string | null>(node ? node.parentId : initialParent);
  const [colorSlot, setColorSlot] = useState<number | null>(node?.colorSlot ?? null);
  const [icon, setIcon] = useState(node?.icon ?? '');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const hasChildren = Boolean(node && node.children.length > 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body = { name, parentId, colorSlot, icon: icon || null };
    const ok = await run(
      () => (node ? api.patch(`/api/categories/${node.id}`, body) : api.post('/api/categories', { kind, ...body })),
      node ? 'Categoria atualizada.' : 'Categoria criada.',
    );
    if (ok) onSaved();
  }

  return (
    <Modal
      open
      title={node ? 'Editar categoria' : `${t.palette.newCategory} de ${t.category.kinds[kind]!.toLowerCase()}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-grid">
        <Field label={t.common.name}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={80} />
        </Field>
        <Field label={t.category.group} hint={hasChildren ? 'Um grupo com subcategorias não vira subcategoria.' : undefined}>
          <select className="field" value={parentId ?? ''} disabled={hasChildren} onChange={(e) => setParentId(e.target.value || null)}>
            <option value="">— é um grupo —</option>
            {groups
              .filter((g) => g.id !== node?.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t.category.color}>
          <div className="slot-picker" role="radiogroup" aria-label={t.category.color}>
            <button
              type="button"
              className={colorSlot === null ? 'active' : ''}
              onClick={() => setColorSlot(null)}
              title="Sem cor"
              aria-label="Sem cor"
            >
              <CategoryDot slot={null} />
            </button>
            {SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                className={colorSlot === slot ? 'active' : ''}
                onClick={() => setColorSlot(slot)}
                title={`Cor ${slot}`}
                aria-label={`Cor ${slot}`}
              >
                <CategoryDot slot={slot} />
              </button>
            ))}
          </div>
        </Field>
        <Field label={t.category.icon} hint="Nome lucide em kebab-case, ex.: shopping-cart.">
          <input className="field field-mono" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="opcional" />
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
