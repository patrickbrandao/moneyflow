import {
  AGENT_TOOL_CATEGORIES,
  type AgentToolCategory,
  type AgentToolInfo,
  type AgentToolMode,
  type AiToolKitDto,
  t,
} from '@moneyflow/shared';
import { ChevronDown, ChevronRight, Copy, Pencil, Plus, Search, Trash2, Wrench } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, cx, EmptyRow, EmptyState, Field, Modal, useConfirm } from '../ui';

const k = t.agentsUi.admin.toolKits;
const categoryName = (category: AgentToolCategory) => t.agents.toolCategories[category] ?? category;

/** Resumo de um kit pelo catálogo: tools de leitura/escrita e quantas pedem aprovação. */
function kitCounts(kit: AiToolKitDto, catalog: Map<string, AgentToolInfo>) {
  let read = 0;
  let write = 0;
  let ask = 0;
  for (const tool of kit.tools) {
    const info = catalog.get(tool.name);
    if (!info) continue;
    if (info.kind === 'read') read += 1;
    else write += 1;
    if (tool.mode === 'ask' || info.secret) ask += 1;
  }
  return { read, write, ask };
}

/** Kits de ferramentas (spec 021): quais tools internas cada agente usa e quais pedem aprovação. */
export function ToolKitsTab() {
  const { data, error, reload } = useApi<AiToolKitDto[]>('/api/admin/ai/tool-kits');
  const tools = useApi<AgentToolInfo[]>('/api/admin/ai/tools');
  const [editing, setEditing] = useState<AiToolKitDto | 'new' | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const catalog = useMemo(() => new Map((tools.data ?? []).map((tool) => [tool.name, tool])), [tools.data]);

  async function duplicate(kit: AiToolKitDto) {
    const copy = await run(
      () => api.post<AiToolKitDto>(`/api/admin/ai/tool-kits/${kit.id}/duplicate`, {}),
      (value) => k.duplicated(value.name),
    );
    if (!copy) return;
    await reload();
    setEditing(copy);
  }

  async function remove(kit: AiToolKitDto) {
    const ok = await confirm({
      title: k.removeConfirm(kit.name),
      description: k.removeDescription,
      confirmLabel: t.common.remove,
      danger: true,
    });
    if (!ok) return;
    const done = await run(() => api.del(`/api/admin/ai/tool-kits/${kit.id}`), k.removed);
    if (done) void reload();
  }

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus /> {k.new}
        </Button>
      </div>
      {data && data.length === 0 ? (
        <EmptyState
          icon={<Wrench />}
          title={k.empty}
          description={k.emptyHint}
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus /> {k.new}
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{k.name}</th>
                <th>{k.tools}</th>
                <th>{k.askColumn}</th>
                <th>{k.agents}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={5} />}
              {data?.length === 0 && <EmptyRow colSpan={5}>{k.empty}</EmptyRow>}
              {data?.map((kit) => {
                const counts = kitCounts(kit, catalog);
                return (
                  <tr key={kit.id} className="cursor-pointer" onClick={() => setEditing(kit)}>
                    <td>
                      <span className="row-title">{kit.name}</span>
                      {kit.description && <span className="row-sub">{kit.description}</span>}
                    </td>
                    <td className="text-[12.5px] text-dim">{k.counts(counts.read, counts.write)}</td>
                    <td className="text-[12.5px] text-dim">{k.askCount(counts.ask)}</td>
                    <td className="text-[12.5px] text-dim">
                      {kit.agents.length === 0
                        ? k.noAgents
                        : kit.agents.map((agent) => (agent.archived ? k.archivedAgent(agent.name) : agent.name)).join(', ')}
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <span className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title={t.common.edit}
                          aria-label={t.common.edit}
                          onClick={() => setEditing(kit)}
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title={k.duplicate}
                          aria-label={k.duplicate}
                          onClick={() => void duplicate(kit)}
                        >
                          <Copy />
                        </button>
                        <button
                          type="button"
                          className="row-action danger"
                          title={t.common.remove}
                          aria-label={t.common.remove}
                          onClick={() => void remove(kit)}
                        >
                          <Trash2 />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <KitFormModal
          key={editing === 'new' ? 'new' : editing.id}
          kit={editing === 'new' ? null : editing}
          tools={tools.data ?? []}
          onClose={() => setEditing(null)}
          onDuplicate={editing === 'new' ? undefined : () => void duplicate(editing)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

/** Checkbox com o estado intermediário (parte das tools da categoria marcada). */
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function ModeSwitch({
  tool,
  mode,
  disabled,
  onChange,
}: {
  tool: AgentToolInfo;
  mode: AgentToolMode;
  disabled: boolean;
  onChange: (mode: AgentToolMode) => void;
}) {
  return (
    <div className={cx('segmented', disabled && 'opacity-50')} role="radiogroup" aria-label={k.modeFor(tool.title)}>
      {(['allow', 'ask'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          className={cx(mode === value && 'active')}
          title={k.modeHelp[value]}
          disabled={disabled || (tool.secret && value === 'allow')}
          onClick={() => onChange(value)}
        >
          {k.modes[value]}
        </button>
      ))}
    </div>
  );
}

function KitFormModal({
  kit,
  tools,
  onClose,
  onSaved,
  onDuplicate,
}: {
  kit: AiToolKitDto | null;
  tools: AgentToolInfo[];
  onClose: () => void;
  onSaved: () => void;
  onDuplicate?: () => void;
}) {
  const [name, setName] = useState(kit?.name ?? '');
  const [description, setDescription] = useState(kit?.description ?? '');
  const [selected, setSelected] = useState<Map<string, AgentToolMode>>(() => new Map((kit?.tools ?? []).map((x) => [x.name, x.mode])));
  /** Modo escolhido para cada tool, mesmo fora do kit (desmarcar e marcar de novo mantém a escolha). */
  const [modes, setModes] = useState<Map<string, AgentToolMode>>(() => new Map((kit?.tools ?? []).map((x) => [x.name, x.mode])));
  const [query, setQuery] = useState('');
  const [onlyIncluded, setOnlyIncluded] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<AgentToolCategory>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  const known = new Set(tools.map((tool) => tool.name));
  const unknown = [...selected.keys()].filter((tool) => tools.length > 0 && !known.has(tool));
  const modeOf = (tool: AgentToolInfo): AgentToolMode =>
    tool.secret ? 'ask' : (selected.get(tool.name) ?? modes.get(tool.name) ?? tool.suggestedMode);

  const needle = query.trim().toLowerCase();
  const visible = (tool: AgentToolInfo) =>
    (!onlyIncluded || selected.has(tool.name)) &&
    (!needle || tool.title.toLowerCase().includes(needle) || tool.name.toLowerCase().includes(needle));

  function include(list: AgentToolInfo[], on: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      for (const tool of list) {
        if (on) next.set(tool.name, modeOf(tool));
        else next.delete(tool.name);
      }
      return next;
    });
  }

  function setMode(list: AgentToolInfo[], mode: AgentToolMode) {
    const apply = (current: Map<string, AgentToolMode>, onlySelected: boolean) => {
      const next = new Map(current);
      for (const tool of list) {
        if (onlySelected && !current.has(tool.name)) continue;
        next.set(tool.name, tool.secret ? 'ask' : mode);
      }
      return next;
    };
    setModes((current) => apply(current, false));
    setSelected((current) => apply(current, true));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body = {
      name: name.trim(),
      description,
      tools: tools.filter((tool) => selected.has(tool.name)).map((tool) => ({ name: tool.name, mode: modeOf(tool) })),
    };
    const saved = await run(
      () =>
        kit ? api.patch<AiToolKitDto>(`/api/admin/ai/tool-kits/${kit.id}`, body) : api.post<AiToolKitDto>('/api/admin/ai/tool-kits', body),
      kit ? k.saved : k.created,
    );
    if (saved) onSaved();
  }

  const total = tools.filter((tool) => selected.has(tool.name)).length;

  return (
    <Modal open title={kit ? k.edit : k.new} onClose={onClose} wide>
      <form onSubmit={submit} autoComplete="off">
        <div className="modal-body form-grid">
          <Field label={k.name}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
          <Field label={k.description}>
            <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </Field>
          {kit && kit.agents.length > 0 && <p className="hint !mt-0">{k.inUseHint(kit.agents.map((agent) => agent.name).join(', '))}</p>}

          <div className="kit-toolbar">
            <span className="kit-search">
              <Search aria-hidden />
              <input
                className="field"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={k.search}
                aria-label={k.search}
              />
            </span>
            <label className="check">
              <input type="checkbox" checked={onlyIncluded} onChange={(e) => setOnlyIncluded(e.target.checked)} /> {k.onlyIncluded}
            </label>
            <span className="text-[12px] text-muted">{k.included(total, tools.length)}</span>
          </div>

          {unknown.length > 0 && <p className="hint !mt-0">{k.unknownTools(unknown.join(', '))}</p>}

          <div className="kit-categories">
            {AGENT_TOOL_CATEGORIES.map((category) => {
              const all = tools.filter((tool) => tool.category === category);
              const shown = all.filter(visible);
              if (all.length === 0 || shown.length === 0) return null;
              const included = all.filter((tool) => selected.has(tool.name)).length;
              const open = !collapsed.has(category) || Boolean(needle);
              const label = categoryName(category);
              return (
                <section key={category} className="kit-cat" data-testid={`kit-category-${category}`}>
                  <div className="kit-cat-head">
                    <TriCheckbox
                      checked={included === all.length}
                      indeterminate={included > 0 && included < all.length}
                      onChange={(on) => include(all, on)}
                      label={k.selectCategory(label)}
                    />
                    <button
                      type="button"
                      className="kit-cat-toggle"
                      aria-expanded={open}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(category)) next.delete(category);
                          else next.add(category);
                          return next;
                        })
                      }
                    >
                      {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                      <span className="row-title">{label}</span>
                      <span className="text-[12px] text-muted">{k.included(included, all.length)}</span>
                    </button>
                    <span className="flex-1" />
                    <button type="button" className="link-action" onClick={() => setMode(all, 'allow')}>
                      {k.allAllow}
                    </button>
                    <button type="button" className="link-action" onClick={() => setMode(all, 'ask')}>
                      {k.allAsk}
                    </button>
                  </div>
                  {open && (
                    <ul className="kit-tools">
                      {shown.map((tool) => {
                        const on = selected.has(tool.name);
                        return (
                          <li key={tool.name} className={cx('kit-tool', !on && 'is-off')} data-testid={`kit-tool-${tool.name}`}>
                            <input
                              type="checkbox"
                              checked={on}
                              aria-label={k.selectTool(tool.title)}
                              onChange={(e) => include([tool], e.target.checked)}
                            />
                            <div className="min-w-0" title={tool.description}>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="kit-tool-title">{tool.title}</span>
                                <Badge tone={tool.kind === 'read' ? 'neutral' : 'info'}>{tool.kind === 'read' ? k.read : k.write}</Badge>
                                {tool.destructive && <Badge tone="danger">{k.destructive}</Badge>}
                                {tool.adminOnly && <Badge tone="outline">{k.adminOnly}</Badge>}
                                {tool.secret && <Badge tone="warn">{k.secret}</Badge>}
                              </div>
                              <span className="mono text-[11px] text-faint">
                                {tool.name}
                                {!on && ` · ${k.notIncluded}`}
                              </span>
                            </div>
                            <ModeSwitch tool={tool} mode={modeOf(tool)} disabled={!on} onChange={(mode) => setMode([tool], mode)} />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
            {tools.length > 0 && !tools.some(visible) && <p className="panel-hint">{k.noMatch}</p>}
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          {onDuplicate && (
            <Button variant="ghost" onClick={onDuplicate}>
              <Copy /> {k.duplicate}
            </Button>
          )}
          <span className="flex-1" />
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
