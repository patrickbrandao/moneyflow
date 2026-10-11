import { type AgentParams, type AgentToolInfo, type AiAgentDto, type AiProviderDto, type McpServerDto, t } from '@moneyflow/shared';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { agentColor } from '../../agents/format';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, cx, EmptyRow, EmptyState, Field, Modal } from '../ui';
import { ActiveBadge, ANTHROPIC_SUGGESTIONS, optionalNumber, useProviderModels, useRemove } from './shared';

const g = t.agentsUi.admin.agents;
const mcpT = t.agentsUi.admin.mcp;

/** Agentes (só o admin cria): provedor/modelo, parâmetros, tools internas, confirmação, cor, ícone e MCPs. */
export function AgentsTab() {
  const { data, error, reload } = useApi<AiAgentDto[]>('/api/admin/ai/agents');
  const [editing, setEditing] = useState<AiAgentDto | 'new' | null>(null);
  const remove = useRemove();

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus /> {g.new}
        </Button>
      </div>
      {data && data.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title={g.empty}
          description={g.emptyHint}
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus /> {g.new}
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{g.name}</th>
                <th>{g.model}</th>
                <th>{g.tools}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={5} />}
              {data?.length === 0 && <EmptyRow colSpan={5}>{g.empty}</EmptyRow>}
              {data?.map((agent) => (
                <tr key={agent.id} className={cx('cursor-pointer', agent.archivedAt && 'is-off')} onClick={() => setEditing(agent)}>
                  <td>
                    <span className="flex items-center gap-2">
                      <span className="agent-dot" style={{ background: agentColor(agent.colorSlot) }} />
                      <span className="row-title">{agent.name}</span>
                    </span>
                    {agent.description && <span className="row-sub">{agent.description}</span>}
                  </td>
                  <td className="mono text-xs">{g.model_(agent.providerName, agent.model)}</td>
                  <td className="text-[12.5px] text-dim">
                    {g.toolsSummary(agent.enabledTools ? agent.enabledTools.length : null)}
                    {agent.mcpServers.length > 0 && ` · ${g.mcpSummary(agent.mcpServers.length)}`}
                  </td>
                  <td>
                    <ActiveBadge active={agent.isActive} archived={Boolean(agent.archivedAt)} />
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title={t.common.edit}
                        aria-label={t.common.edit}
                        onClick={() => setEditing(agent)}
                      >
                        <Pencil />
                      </button>
                      <button
                        type="button"
                        className="row-action danger"
                        title={t.common.remove}
                        aria-label={t.common.remove}
                        onClick={() => void remove(`/api/admin/ai/agents/${agent.id}`, agent.name, () => void reload())}
                      >
                        <Trash2 />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <AgentFormModal
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

type McpLink = { linked: boolean; restrict: boolean; tools: string[] };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="admin-ai-section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function AgentFormModal({ agent, onClose, onSaved }: { agent: AiAgentDto | null; onClose: () => void; onSaved: () => void }) {
  const providers = useApi<AiProviderDto[]>('/api/admin/ai/providers');
  const tools = useApi<AgentToolInfo[]>('/api/admin/ai/tools');
  const servers = useApi<McpServerDto[]>('/api/admin/ai/mcp-servers');
  const [models] = useProviderModels();
  const listId = useId();

  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [providerId, setProviderId] = useState(agent?.providerId ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const params = agent?.params ?? {};
  const [maxTokens, setMaxTokens] = useState(params.max_tokens?.toString() ?? '');
  const [maxIterations, setMaxIterations] = useState(params.max_tool_iterations?.toString() ?? '');
  const [temperature, setTemperature] = useState(params.temperature?.toString() ?? '');
  const [topP, setTopP] = useState(params.top_p?.toString() ?? '');
  const [thinking, setThinking] = useState(params.thinking_budget_tokens?.toString() ?? '');
  const [effort, setEffort] = useState<AgentParams['reasoning_effort'] | ''>(params.reasoning_effort ?? '');
  const [allTools, setAllTools] = useState(agent ? agent.enabledTools === null : true);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(agent?.enabledTools ?? []));
  const [requireConfirmation, setRequireConfirmation] = useState(agent?.requireWriteConfirmation ?? true);
  const [colorSlot, setColorSlot] = useState(agent?.colorSlot ?? 1);
  const [icon, setIcon] = useState(agent?.icon ?? '');
  const [isActive, setIsActive] = useState(agent?.isActive ?? false);
  const [links, setLinks] = useState<Record<string, McpLink>>(() =>
    Object.fromEntries(
      (agent?.mcpServers ?? []).map((l) => [
        l.mcpServerId,
        { linked: true, restrict: l.enabledTools !== null, tools: l.enabledTools ?? [] },
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  const provider = providers.data?.find((x) => x.id === providerId);
  const suggestions = [...new Set([...(models[providerId] ?? []), ...(provider?.kind === 'anthropic' ? ANTHROPIC_SUGGESTIONS : [])])];
  const toolList = tools.data ?? [];

  function toggleTool(name: string) {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function setLink(id: string, patch: Partial<McpLink>) {
    setLinks((all) => {
      const current = all[id] ?? { linked: false, restrict: false, tools: [] };
      return { ...all, [id]: { ...current, ...patch } };
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (isActive && (!providerId || !model.trim())) return setError(g.activeHint);
    setError(null);
    const nextParams: AgentParams = {};
    const put = <K extends keyof AgentParams>(key: K, value: AgentParams[K] | undefined) => {
      if (value !== undefined) nextParams[key] = value;
    };
    put('max_tokens', optionalNumber(maxTokens));
    put('max_tool_iterations', optionalNumber(maxIterations));
    put('temperature', optionalNumber(temperature));
    put('top_p', optionalNumber(topP));
    put('thinking_budget_tokens', optionalNumber(thinking));
    if (effort) nextParams.reasoning_effort = effort;
    const mcpServers = Object.entries(links)
      .filter(([, link]) => link.linked)
      .map(([mcpServerId, link]) => ({ mcpServerId, enabledTools: link.restrict ? link.tools : null }));
    const body = {
      name: name.trim(),
      description,
      systemPrompt,
      providerId: providerId || null,
      model: model.trim(),
      params: nextParams,
      enabledTools: allTools ? null : [...enabled],
      requireWriteConfirmation: requireConfirmation,
      colorSlot,
      icon: icon.trim(),
      isActive,
      mcpServers,
    };
    const saved = await run(
      () => (agent ? api.patch<AiAgentDto>(`/api/admin/ai/agents/${agent.id}`, body) : api.post<AiAgentDto>('/api/admin/ai/agents', body)),
      agent ? g.saved : g.created,
    );
    if (saved) onSaved();
  }

  const toolGroup = (kind: 'read' | 'write') => {
    const items = toolList.filter((x) => x.kind === kind);
    if (items.length === 0) return null;
    const checked = items.filter((x) => enabled.has(x.name)).length;
    return (
      <div className="admin-ai-tools">
        <div className="admin-ai-tools-head">
          <span className="label !mb-0">
            {kind === 'read' ? g.toolsRead : g.toolsWrite} · {g.toolsCount(checked, items.length)}
          </span>
          <button
            type="button"
            className="link-action"
            onClick={() =>
              setEnabled((current) => {
                const next = new Set(current);
                for (const x of items) {
                  if (checked === items.length) next.delete(x.name);
                  else next.add(x.name);
                }
                return next;
              })
            }
          >
            {checked === items.length ? g.selectNone : g.selectAll}
          </button>
        </div>
        <div className="admin-ai-checks">
          {items.map((tool) => (
            <label key={tool.name} className="check" title={tool.description}>
              <input type="checkbox" checked={enabled.has(tool.name)} onChange={() => toggleTool(tool.name)} />
              <span>
                {tool.title} <span className="mono text-[11px] text-faint">{tool.name}</span>
                {tool.confirm === 'always' && <span className="text-[11px] text-faint"> · {g.confirmAlways}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Modal open title={agent ? g.edit : g.new} onClose={onClose} wide>
      <form onSubmit={submit} autoComplete="off">
        <div className="modal-body form-grid">
          <div className="form-grid cols-2">
            <Field label={g.name}>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
            </Field>
            <Field label={g.icon} hint={g.iconHint}>
              <input
                className="field field-mono"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="bot"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                spellCheck={false}
              />
            </Field>
          </div>
          <Field label={g.description}>
            <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </Field>
          <Field label={g.systemPrompt} hint={g.systemPromptHint}>
            <textarea className="field" rows={6} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </Field>
          <div className="form-grid cols-2">
            <Field label={g.provider}>
              <select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                <option value="">{g.noProvider}</option>
                {(providers.data ?? [])
                  .filter((x) => !x.archivedAt || x.id === providerId)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.isActive ? '' : ` (${t.agentsUi.admin.inactive})`}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={g.model} hint={suggestions.length ? g.modelHint : undefined}>
              <input
                className="field field-mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list={listId}
                spellCheck={false}
                placeholder={provider?.kind === 'anthropic' ? 'claude-sonnet-5-5' : ''}
              />
              <datalist id={listId}>
                {suggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>

          <Section title={g.params}>
            <div className="form-grid cols-3">
              <Field label={g.maxTokens}>
                <input
                  className="field field-mono"
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder={g.defaultValue}
                />
              </Field>
              <Field label={g.maxToolIterations}>
                <input
                  className="field field-mono"
                  inputMode="numeric"
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(e.target.value)}
                  placeholder={g.defaultValue}
                />
              </Field>
              <Field label={g.thinkingBudget}>
                <input
                  className="field field-mono"
                  inputMode="numeric"
                  value={thinking}
                  onChange={(e) => setThinking(e.target.value)}
                  placeholder={g.defaultValue}
                />
              </Field>
              <Field label={g.temperature}>
                <input
                  className="field field-mono"
                  inputMode="decimal"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder={g.defaultValue}
                />
              </Field>
              <Field label={g.topP}>
                <input
                  className="field field-mono"
                  inputMode="decimal"
                  value={topP}
                  onChange={(e) => setTopP(e.target.value)}
                  placeholder={g.defaultValue}
                />
              </Field>
              <Field label={g.reasoningEffort}>
                <select
                  className="field"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value as AgentParams['reasoning_effort'] | '')}
                >
                  <option value="">{g.defaultValue}</option>
                  {(['minimal', 'low', 'medium', 'high'] as const).map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>

          <Section title={g.tools}>
            <div className="segmented mb-3" role="group" aria-label={g.tools}>
              <button type="button" className={cx(allTools && 'active')} aria-pressed={allTools} onClick={() => setAllTools(true)}>
                {g.toolsAll}
              </button>
              <button type="button" className={cx(!allTools && 'active')} aria-pressed={!allTools} onClick={() => setAllTools(false)}>
                {g.toolsSelected}
              </button>
            </div>
            {!allTools && (
              <>
                {toolGroup('read')}
                {toolGroup('write')}
              </>
            )}
            <label className="check mt-2">
              <input type="checkbox" checked={requireConfirmation} onChange={(e) => setRequireConfirmation(e.target.checked)} />{' '}
              {g.requireConfirmation}
            </label>
          </Section>

          <Section title={g.mcpServers}>
            {servers.data && servers.data.filter((s) => !s.archivedAt).length === 0 && <p className="panel-hint">{g.mcpNone}</p>}
            <div className="grid gap-2">
              {(servers.data ?? [])
                .filter((s) => !s.archivedAt)
                .map((server) => {
                  const link = links[server.id] ?? { linked: false, restrict: false, tools: [] };
                  const global = server.visibility === 'global';
                  const cached = server.tools ?? [];
                  return (
                    <div key={server.id} className="well !py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="row-title">{server.name}</span>
                        <Badge tone={global ? 'accent' : 'outline'}>{mcpT.visibilities[server.visibility]}</Badge>
                        {!server.isActive && <Badge tone="neutral">{t.agentsUi.admin.inactive}</Badge>}
                        <span className="flex-1" />
                        {global ? (
                          <span className="text-[12px] text-muted">{g.mcpGlobal}</span>
                        ) : (
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={link.linked}
                              onChange={(e) => setLink(server.id, { linked: e.target.checked })}
                            />{' '}
                            {g.mcpLink}
                          </label>
                        )}
                      </div>
                      {server.visibility === 'private' && !link.linked && <p className="hint">{g.mcpPrivateHint}</p>}
                      {(global || link.linked) && (
                        <div className="mt-2">
                          <div className="segmented" role="group">
                            <button
                              type="button"
                              className={cx(!(link.linked && link.restrict) && 'active')}
                              onClick={() => setLink(server.id, global ? { linked: false, restrict: false } : { restrict: false })}
                            >
                              {g.mcpAllTools}
                            </button>
                            <button
                              type="button"
                              className={cx(link.linked && link.restrict && 'active')}
                              onClick={() => setLink(server.id, { linked: true, restrict: true })}
                            >
                              {g.mcpSomeTools}
                            </button>
                          </div>
                          {link.linked && link.restrict && (
                            <div className="admin-ai-checks mt-2">
                              {cached.length === 0 && <p className="hint">{g.mcpNoCache}</p>}
                              {cached.map((tool) => (
                                <label key={tool.name} className="check" title={tool.description}>
                                  <input
                                    type="checkbox"
                                    checked={link.tools.includes(tool.name)}
                                    onChange={(e) =>
                                      setLink(server.id, {
                                        tools: e.target.checked ? [...link.tools, tool.name] : link.tools.filter((x) => x !== tool.name),
                                      })
                                    }
                                  />
                                  <span className="mono text-[12px]">{tool.name}</span>
                                  {tool.annotations?.readOnlyHint && <span className="text-[11px] text-faint">{mcpT.readOnly}</span>}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </Section>

          <Field label={g.color}>
            <div className="slot-picker" role="radiogroup" aria-label={g.color}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  role="radio"
                  aria-checked={colorSlot === slot}
                  aria-label={`${g.color} ${slot}`}
                  className={cx(colorSlot === slot && 'active')}
                  onClick={() => setColorSlot(slot)}
                >
                  <span className="cat-dot" style={{ background: agentColor(slot) }} />
                </button>
              ))}
            </div>
          </Field>
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> {g.active}
          </label>
          {isActive && (!providerId || !model.trim()) && <p className="hint">{g.activeHint}</p>}
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
