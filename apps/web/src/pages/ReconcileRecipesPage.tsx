import {
  type AccountRow,
  type AgentOptionDto,
  type CaixaSummary,
  formatDateTime,
  importLink,
  PROMPT_VARIABLES,
  RECIPE_PROMPT_VARIABLES,
  type ReconcileRecipeDto,
  type ReconcileRecipeRunDto,
  renderRecipeVariables,
  scanRecipeVariables,
  t,
  volatilePromptValues,
} from '@moneyflow/shared';
import { Archive, ArchiveRestore, BookOpenCheck, History, Pencil, Plus } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgents } from '../agents/AgentsProvider';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { FormError, ModalActions } from '../components/forms';
import { recipeRunLabel } from '../components/reconciliation/RecipesPanel';
import { Badge, Button, cx, EmptyRow, Field, Modal, Panel, Tabs, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';

const k = t.agentsUi.recipes;

/**
 * Conciliação → Receitas (spec 030): lista das receitas visíveis (as das
 * caixas que o usuário lê e as globais), o formulário (agente com o aviso de
 * agente sem kit, instrução com as variáveis e a prévia, contas vinculadas,
 * "rodar ao importar", ordem e ativa) e o histórico de execuções. O play fica
 * na tela do lote.
 */
export function ReconcileRecipesPage() {
  const user = useUser();
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useApi<ReconcileRecipeDto[]>(`/api/reconcile-recipes${archived ? '?archived=true' : ''}`);
  const [editing, setEditing] = useState<ReconcileRecipeDto | 'new' | null>(null);
  const [history, setHistory] = useState<ReconcileRecipeDto | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const canCreate = user.role === 'admin' || user.memberships.some((m) => m.role === 'editor');

  async function toggle(recipe: ReconcileRecipeDto) {
    if (await run(() => api.patch(`/api/reconcile-recipes/${recipe.id}`, { isActive: !recipe.isActive }), k.saved)) void reload();
  }

  async function archive(recipe: ReconcileRecipeDto) {
    const ok = await confirm({ title: k.archiveConfirm(recipe.name), description: k.archiveHint, confirmLabel: k.archive, danger: true });
    if (ok && (await run(() => api.del(`/api/reconcile-recipes/${recipe.id}`), k.archivedToast))) void reload();
  }

  async function restore(recipe: ReconcileRecipeDto) {
    if (await run(() => api.post(`/api/reconcile-recipes/${recipe.id}/restore`), k.restored)) void reload();
  }

  const cols = 8;
  return (
    <div className="page wide">
      <PageHead
        title={k.title}
        sub={k.pageSub}
        actions={
          canCreate && (
            <Button onClick={() => setEditing('new')} data-testid="recipe-new">
              <Plus /> {k.new}
            </Button>
          )
        }
      />
      <Tabs
        value={archived ? 'archived' : 'active'}
        onChange={(key) => setArchived(key === 'archived')}
        items={[
          { key: 'active', label: k.active, icon: <BookOpenCheck /> },
          { key: 'archived', label: k.archived, icon: <Archive /> },
        ]}
      />
      <Panel>
        {error ? (
          <LoadError error={error} onRetry={() => void reload()} />
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="recipes-table">
              <thead>
                <tr>
                  <th>{k.name}</th>
                  <th>{k.owner}</th>
                  <th>{k.agent}</th>
                  <th>{k.targets}</th>
                  <th>{k.runOnImport}</th>
                  <th>{k.last}</th>
                  <th>{k.isActive}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!data && <SkelRows cols={cols} rows={2} />}
                {data?.length === 0 && <EmptyRow colSpan={cols}>{archived ? k.emptyArchived : k.empty}</EmptyRow>}
                {data?.map((recipe) => {
                  const last = recipe.lastRun ? recipeRunLabel(recipe.lastRun) : null;
                  return (
                    <tr key={recipe.id} className={cx(!recipe.isActive && 'is-off')} data-testid="recipe-row">
                      <td>
                        <span className="row-title">{recipe.name}</span>
                        <span className="row-sub">{recipe.description || recipe.instruction.slice(0, 80)}</span>
                      </td>
                      <td>{recipe.caixaName ?? <Badge tone="outline">{k.global}</Badge>}</td>
                      <td>
                        {recipe.agentName}
                        {!recipe.agentHasKit && <span className="row-sub text-warn">{k.noKit(recipe.agentName)}</span>}
                      </td>
                      <td className="text-xs">{recipe.targets.map((x) => x.name).join(', ') || k.noTargets}</td>
                      <td>{recipe.runOnImport ? `${t.common.yes} (${recipe.position})` : t.common.no}</td>
                      <td>
                        {last ? (
                          <Badge tone={last.tone}>
                            <span title={last.title}>{last.label}</span>
                          </Badge>
                        ) : (
                          <span className="text-xs text-faint">{k.never}</span>
                        )}
                      </td>
                      <td>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={recipe.isActive}
                            disabled={!recipe.canEdit || Boolean(recipe.archivedAt)}
                            onChange={() => void toggle(recipe)}
                            aria-label={`${k.isActive}: ${recipe.name}`}
                          />
                        </label>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="row-action"
                          title={k.history}
                          aria-label={`${k.history}: ${recipe.name}`}
                          onClick={() => setHistory(recipe)}
                        >
                          <History />
                        </button>
                        {recipe.canEdit && !recipe.archivedAt && (
                          <>
                            <button
                              type="button"
                              className="row-action"
                              title={k.edit}
                              aria-label={`${k.edit}: ${recipe.name}`}
                              onClick={() => setEditing(recipe)}
                            >
                              <Pencil />
                            </button>
                            <button
                              type="button"
                              className="row-action danger"
                              title={k.archive}
                              aria-label={`${k.archive}: ${recipe.name}`}
                              onClick={() => void archive(recipe)}
                            >
                              <Archive />
                            </button>
                          </>
                        )}
                        {recipe.canEdit && recipe.archivedAt && (
                          <button
                            type="button"
                            className="row-action"
                            title={k.restore}
                            aria-label={`${k.restore}: ${recipe.name}`}
                            onClick={() => void restore(recipe)}
                          >
                            <ArchiveRestore />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {editing && (
        <RecipeFormModal
          recipe={editing === 'new' ? null : editing}
          isAdmin={user.role === 'admin'}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {history && <RecipeHistoryModal recipe={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** Valores de exemplo das variáveis (a prévia da instrução). */
function sampleValues(user: { username: string; email: string }, agent: string) {
  return {
    'agente.nome': agent,
    'usuario.nome': user.username,
    'usuario.login': user.username,
    'usuario.email': user.email,
    ...volatilePromptValues(),
    'lote.id': '00000000-0000-0000-0000-000000000000',
    'lote.arquivo': 'extrato-outubro.ofx',
    'lote.periodo': '01/10/2026 a 31/10/2026',
    'conta.nome': 'Conta corrente',
    'caixa.nome': 'Casa',
    'caixa.titular': 'Titular',
    'linhas.total': '34',
  };
}

function RecipeFormModal({
  recipe,
  isAdmin,
  onClose,
  onSaved,
}: {
  recipe: ReconcileRecipeDto | null;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const user = useUser();
  const agents = useApi<AgentOptionDto[]>('/api/agents');
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const accounts = useApi<AccountRow[]>('/api/accounts');
  const writable = (caixas.data ?? []).filter((c) => !c.archivedAt && (c.myRole === 'admin' || c.myRole === 'editor'));
  const [owner, setOwner] = useState<string>(recipe ? (recipe.caixaId ?? 'global') : '');
  const [name, setName] = useState(recipe?.name ?? '');
  const [description, setDescription] = useState(recipe?.description ?? '');
  const [agentId, setAgentId] = useState(recipe?.agentId ?? '');
  const [instruction, setInstruction] = useState(recipe?.instruction ?? '');
  const [accountIds, setAccountIds] = useState<string[]>(recipe?.targets.filter((x) => x.kind === 'account').map((x) => x.id) ?? []);
  const [cardIds, setCardIds] = useState<string[]>(recipe?.targets.filter((x) => x.kind === 'card').map((x) => x.id) ?? []);
  const [runOnImport, setRunOnImport] = useState(recipe?.runOnImport ?? false);
  const [position, setPosition] = useState(recipe?.position ?? 0);
  const [active, setActive] = useState(recipe?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  const ownerChoice = owner || writable[0]?.id || (isAdmin ? 'global' : '');
  const caixaId = ownerChoice === 'global' ? null : ownerChoice;
  const agentChoice = agentId || agents.data?.[0]?.id || '';
  const agent = agents.data?.find((a) => a.id === agentChoice);
  const scan = useMemo(() => scanRecipeVariables(instruction), [instruction]);
  const preview = useMemo(
    () => renderRecipeVariables(instruction, sampleValues(user, agent?.name ?? '')),
    [instruction, user, agent?.name],
  );
  // Contas da dona (a global vincula qualquer uma); cartões: o banco confere a dona (o próprio cartão ou a pagadora padrão).
  const accountOptions = (accounts.data ?? []).filter(
    (a) => (a.kind === 'checking' || a.kind === 'savings') && (caixaId === null || a.caixaId === caixaId),
  );
  const cardOptions = (caixas.data ?? []).filter((c) => c.kind === 'credit_card' && !c.archivedAt);
  const hasTargets = accountIds.length + cardIds.length > 0;

  const toggleIn = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!agentChoice) return setError(k.noAgents);
    if (scan.unknown.length > 0) return setError(`Variável desconhecida: ${scan.unknown.map((v) => `{{${v}}}`).join(', ')}`);
    if (runOnImport && !hasTargets) return setError(k.runOnImportHint);
    setError(null);
    const body = {
      agentId: agentChoice,
      name: name.trim(),
      description: description.trim() || null,
      instruction: instruction.trim(),
      accountIds,
      cardCaixaIds: cardIds,
      runOnImport,
      position,
      isActive: active,
    };
    const saved = await run(
      () =>
        recipe
          ? api.patch<ReconcileRecipeDto>(`/api/reconcile-recipes/${recipe.id}`, body)
          : api.post<ReconcileRecipeDto>('/api/reconcile-recipes', { ...body, caixaId }),
      k.saved,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={recipe ? k.edit : k.new} onClose={onClose} wide>
      <form onSubmit={submit} autoComplete="off" data-testid="recipe-form">
        <div className="modal-body form-grid">
          <div className="form-grid cols-2">
            <Field label={k.name}>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
            </Field>
            <Field label={k.owner}>
              <select
                className="field"
                value={ownerChoice}
                disabled={Boolean(recipe)}
                onChange={(e) => {
                  setOwner(e.target.value);
                  setAccountIds([]);
                  setCardIds([]);
                }}
                data-testid="recipe-owner"
              >
                {recipe?.caixaId && !writable.some((c) => c.id === recipe.caixaId) && (
                  <option value={recipe.caixaId}>{recipe.caixaName}</option>
                )}
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {(isAdmin || recipe?.caixaId === null) && <option value="global">{k.global}</option>}
              </select>
            </Field>
          </div>
          <Field label={k.description}>
            <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </Field>
          <Field label={k.agent}>
            <select className="field" value={agentChoice} onChange={(e) => setAgentId(e.target.value)} required data-testid="recipe-agent">
              {agents.data?.length === 0 && <option value="">{k.noAgents}</option>}
              {agents.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          {agent && agent.hasKit === false && <p className="notice warn text-[12px]">{k.noKit(agent.name)}</p>}
          <Field label={k.instruction} hint={k.instructionHint}>
            <textarea
              className="field"
              rows={6}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={20_000}
              required
              data-testid="recipe-instruction"
            />
          </Field>
          <details>
            <summary className="text-[13px]">{k.variables}</summary>
            <ul className="mt-1 grid gap-0.5 text-xs">
              {[...RECIPE_PROMPT_VARIABLES, ...PROMPT_VARIABLES].map((v) => (
                <li key={v.name}>
                  <code>{`{{${v.name}}}`}</code> <span className="text-faint">{v.description}</span>
                </li>
              ))}
            </ul>
          </details>
          {instruction.trim() && (
            <Field label={k.preview}>
              <pre className="well text-xs whitespace-pre-wrap" data-testid="recipe-preview">
                {preview}
              </pre>
            </Field>
          )}
          <div role="group" aria-label={k.targets}>
            <span className="label">{k.targets}</span>
            <p className="hint">{k.targetsHint}</p>
            <div className="flex flex-wrap gap-3">
              {accountOptions.map((a) => (
                <label key={a.id} className="check">
                  <input
                    type="checkbox"
                    checked={accountIds.includes(a.id)}
                    onChange={(e) => setAccountIds((list) => toggleIn(list, a.id, e.target.checked))}
                  />{' '}
                  {a.name} <span className="text-faint">({a.caixaName})</span>
                </label>
              ))}
              {cardOptions.map((c) => (
                <label key={c.id} className="check">
                  <input
                    type="checkbox"
                    checked={cardIds.includes(c.id)}
                    onChange={(e) => setCardIds((list) => toggleIn(list, c.id, e.target.checked))}
                  />{' '}
                  {c.name}
                </label>
              ))}
            </div>
          </div>
          <div className="form-grid cols-2">
            <div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={runOnImport}
                  onChange={(e) => setRunOnImport(e.target.checked)}
                  data-testid="recipe-run-on-import"
                />{' '}
                {k.runOnImport}
              </label>
              <p className="hint">{k.runOnImportHint}</p>
            </div>
            <Field label={k.position} hint={k.positionHint}>
              <input
                className="field field-mono"
                type="number"
                min={0}
                max={100_000}
                value={position}
                onChange={(e) => setPosition(Math.max(0, Math.min(100_000, Number(e.target.value) || 0)))}
              />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {k.isActive}
          </label>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !instruction.trim() || !ownerChoice} data-testid="recipe-save">
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function RecipeHistoryModal({ recipe, onClose }: { recipe: ReconcileRecipeDto; onClose: () => void }) {
  const { data, error, reload } = useApi<ReconcileRecipeRunDto[]>(`/api/reconcile-recipes/${recipe.id}/runs`);
  const agents = useAgents();
  return (
    <Modal open title={`${k.history}: ${recipe.name}`} onClose={onClose} wide>
      <div className="modal-body">
        {error ? (
          <LoadError error={error} onRetry={() => void reload()} />
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="recipe-history">
              <thead>
                <tr>
                  <th>{t.common.date}</th>
                  <th>{t.common.kind}</th>
                  <th>{t.common.status}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!data && <SkelRows cols={4} rows={2} />}
                {data?.length === 0 && <EmptyRow colSpan={4}>{k.historyEmpty}</EmptyRow>}
                {data?.map((r) => {
                  const label = recipeRunLabel(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <span className="mono text-xs">{formatDateTime(r.createdAt)}</span>
                        <span className="row-sub">
                          {r.fileName} · {k.by(r.username)}
                        </span>
                      </td>
                      <td>
                        {k.trigger[r.triggerKind]} · {k.lines(r.lineCount)}
                      </td>
                      <td>
                        <Badge tone={label.tone}>{label.label}</Badge>
                        {label.title && <span className="row-sub">{label.title}</span>}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <Link
                          className="link mr-3"
                          to={importLink({
                            id: r.importId,
                            caixaId: r.caixaId,
                            financialAccountId: r.financialAccountId,
                            cardCaixaId: r.cardCaixaId,
                          })}
                          onClick={onClose}
                        >
                          {k.openImport}
                        </Link>
                        {r.conversationId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              void agents.openById(r.conversationId!);
                              onClose();
                            }}
                          >
                            {k.openSession}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
