import {
  type AgentParams,
  type AiAgentDto,
  type AiProviderDto,
  type AiToolKitDto,
  type McpServerDto,
  scanPromptVariables,
  t,
} from '@moneyflow/shared';
import { Bot, Eye, History, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { agentColor } from '../../agents/format';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, cx, EmptyRow, EmptyState, Field, Modal } from '../ui';
import { PromptHistory, PromptPreview, PromptVariables } from './AgentPrompt';
import { ActiveBadge, ANTHROPIC_SUGGESTIONS, optionalNumber, useProviderModels, useRemove } from './shared';

const g = t.agentsUi.admin.agents;
const mcpT = t.agentsUi.admin.mcp;
const promptT = t.agentsUi.admin.prompt;

/** Agentes (só o admin cria): provedor/modelo, parâmetros, kit de ferramentas (spec 021), cor, ícone e MCPs. */
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
                    {g.toolsSummary(agent.toolKitName)}
                    {agent.mcpServers.length > 0 && ` · ${g.mcpSummary(agent.mcpServers.length)}`}
                  </td>
                  <td>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <ActiveBadge active={agent.isActive} archived={Boolean(agent.archivedAt)} />
                      {agent.useForFlows && (
                        <Badge tone="accent" title={g.flowsBadgeTitle}>
                          {g.flowsBadge}
                        </Badge>
                      )}
                    </span>
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
          onChanged={() => void reload()}
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

function AgentFormModal({
  agent: initial,
  onClose,
  onSaved,
  onChanged,
}: {
  agent: AiAgentDto | null;
  onClose: () => void;
  onSaved: () => void;
  /** Mudou fora do "Salvar" (restaurar uma versão do prompt): recarrega a lista sem fechar. */
  onChanged: () => void;
}) {
  // O agente salvo (a versão atual do prompt muda ao restaurar pelo histórico).
  const [agent, setAgent] = useState(initial);
  const [view, setView] = useState<'form' | 'history' | 'preview'>('form');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const providers = useApi<AiProviderDto[]>('/api/admin/ai/providers');
  const kits = useApi<AiToolKitDto[]>('/api/admin/ai/tool-kits');
  const servers = useApi<McpServerDto[]>('/api/admin/ai/mcp-servers');
  const [models] = useProviderModels();
  const listId = useId();

  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [promptNote, setPromptNote] = useState('');
  const scan = useMemo(() => scanPromptVariables(systemPrompt), [systemPrompt]);
  const promptChanged = systemPrompt !== (agent?.systemPrompt ?? '');
  const [providerId, setProviderId] = useState(agent?.providerId ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const params = agent?.params ?? {};
  const [maxTokens, setMaxTokens] = useState(params.max_tokens?.toString() ?? '');
  const [maxIterations, setMaxIterations] = useState(params.max_tool_iterations?.toString() ?? '');
  const [temperature, setTemperature] = useState(params.temperature?.toString() ?? '');
  const [topP, setTopP] = useState(params.top_p?.toString() ?? '');
  const [thinking, setThinking] = useState(params.thinking_budget_tokens?.toString() ?? '');
  const [effort, setEffort] = useState<AgentParams['reasoning_effort'] | ''>(params.reasoning_effort ?? '');
  const [toolKitId, setToolKitId] = useState(agent?.toolKitId ?? '');
  const [colorSlot, setColorSlot] = useState(agent?.colorSlot ?? 1);
  const [icon, setIcon] = useState(agent?.icon ?? '');
  const [isActive, setIsActive] = useState(agent?.isActive ?? false);
  const [useForFlows, setUseForFlows] = useState(agent?.useForFlows ?? false);
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

  function setLink(id: string, patch: Partial<McpLink>) {
    setLinks((all) => {
      const current = all[id] ?? { linked: false, restrict: false, tools: [] };
      return { ...all, [id]: { ...current, ...patch } };
    });
  }

  /** Insere a variável na posição do cursor do prompt. */
  function insertVariable(token: string) {
    const area = promptRef.current;
    const start = area?.selectionStart ?? systemPrompt.length;
    const end = area?.selectionEnd ?? systemPrompt.length;
    setSystemPrompt(systemPrompt.slice(0, start) + token + systemPrompt.slice(end));
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (scan.unknown.length > 0) return setError(g.unknownVariables(scan.unknown.map((n) => `{{${n}}}`).join(', ')));
    if (isActive && (!providerId || !model.trim())) return setError(g.activeHint);
    if (useForFlows && !isActive) return setError(g.useForFlowsNeedsActive);
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
      promptNote: promptChanged || !agent ? promptNote : null,
      providerId: providerId || null,
      model: model.trim(),
      params: nextParams,
      toolKitId: toolKitId || null,
      colorSlot,
      icon: icon.trim(),
      isActive,
      useForFlows,
      mcpServers,
    };
    const saved = await run(
      () => (agent ? api.patch<AiAgentDto>(`/api/admin/ai/agents/${agent.id}`, body) : api.post<AiAgentDto>('/api/admin/ai/agents', body)),
      agent ? g.saved : g.created,
    );
    if (saved) onSaved();
  }

  if (agent && view === 'history') {
    return (
      <Modal open title={promptT.historyTitle(agent.name)} onClose={onClose} wide>
        <PromptHistory
          agent={agent}
          onBack={() => setView('form')}
          onRestored={(saved) => {
            // O prompt restaurado entra no formulário (o que estava sendo editado e não foi salvo é trocado).
            setAgent(saved);
            setSystemPrompt(saved.systemPrompt);
            setPromptNote('');
            onChanged();
          }}
        />
      </Modal>
    );
  }
  if (agent && view === 'preview') {
    return (
      <Modal open title={promptT.previewTitle(agent.name)} onClose={onClose} wide>
        <PromptPreview agent={agent} dirty={promptChanged} onBack={() => setView('form')} />
      </Modal>
    );
  }

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
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="label !mb-0">{g.systemPrompt}</span>
              {agent?.promptVersion && (
                <span data-testid="prompt-version">
                  <Badge tone="outline">{g.promptVersion(agent.promptVersion)}</Badge>
                </span>
              )}
              <span className="flex-1" />
              {agent && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setView('history')}>
                    <History /> {g.history}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setView('preview')}>
                    <Eye /> {g.preview}
                  </Button>
                </>
              )}
            </div>
            <textarea
              ref={promptRef}
              className="field"
              rows={6}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              aria-label={g.systemPrompt}
            />
            <p className="hint">{g.systemPromptHint}</p>
            {scan.unknown.length > 0 && (
              <p className="notice danger mt-2">{g.unknownVariables(scan.unknown.map((n) => `{{${n}}}`).join(', '))}</p>
            )}
            {scan.volatile && (
              <p className="notice warn mt-2" data-testid="prompt-volatile-warning">
                {g.volatileWarning}
              </p>
            )}
          </div>
          <PromptVariables onInsert={insertVariable} />
          {(promptChanged || !agent) && (
            <Field label={g.promptNote} hint={g.promptNoteHint}>
              <input className="field" value={promptNote} onChange={(e) => setPromptNote(e.target.value)} maxLength={500} />
            </Field>
          )}
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
            <Field label={g.toolKit} hint={g.toolKitHint}>
              <select className="field" value={toolKitId} onChange={(e) => setToolKitId(e.target.value)} data-testid="agent-tool-kit">
                <option value="">{g.toolKitNone}</option>
                {(kits.data ?? []).map((kit) => (
                  <option key={kit.id} value={kit.id}>
                    {kit.name}
                  </option>
                ))}
              </select>
            </Field>
            <Link className="link-action mt-2 inline-block text-[12px]" to="/admin/ai/tool-kits">
              {g.toolKitManage}
            </Link>
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
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => {
                setIsActive(e.target.checked);
                if (!e.target.checked) setUseForFlows(false);
              }}
            />{' '}
            {g.active}
          </label>
          {isActive && (!providerId || !model.trim()) && <p className="hint">{g.activeHint}</p>}
          <label className="check">
            <input type="checkbox" checked={useForFlows} disabled={!isActive} onChange={(e) => setUseForFlows(e.target.checked)} />{' '}
            {g.useForFlows}
          </label>
          <p className="hint">{isActive ? g.useForFlowsHint : g.useForFlowsNeedsActive}</p>
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
