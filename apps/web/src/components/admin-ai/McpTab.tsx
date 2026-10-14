import {
  formatDateTime,
  MCP_INSTRUCTIONS_MODES,
  type McpInstructionsMode,
  type McpServerDto,
  type McpVisibility,
  t,
} from '@moneyflow/shared';
import { ChevronRight, Pencil, Plug, Plus, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, cx, EmptyRow, EmptyState, Field, Modal } from '../ui';
import { ActiveBadge, useRemove } from './shared';

const m = t.agentsUi.admin.mcp;

/** Servidores MCP remotos (Streamable HTTP): cabeçalhos write-only, visibilidade e o cache das tools. */
export function McpTab() {
  const { data, error, reload, setData } = useApi<McpServerDto[]>('/api/admin/ai/mcp-servers');
  const [editing, setEditing] = useState<McpServerDto | 'new' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const { run } = useAction();
  const remove = useRemove();

  async function refresh(server: McpServerDto) {
    setRefreshing(server.id);
    const result = await run(() => api.post<McpServerDto>(`/api/admin/ai/mcp-servers/${server.id}/refresh`));
    setRefreshing(null);
    if (!result) return;
    setData((list) => (list ?? []).map((s) => (s.id === result.id ? result : s)));
    setExpanded(result.id);
  }

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus /> {m.new}
        </Button>
      </div>
      {data && data.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title={m.empty}
          description={m.emptyHint}
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus /> {m.new}
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{m.name}</th>
                <th>{m.visibility}</th>
                <th>{m.toolsColumn}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={5} />}
              {data?.length === 0 && <EmptyRow colSpan={5}>{m.empty}</EmptyRow>}
              {data?.map((server) => (
                <Fragment key={server.id}>
                  <tr
                    className={cx('cursor-pointer', server.archivedAt && 'is-off', expanded === server.id && 'is-selected')}
                    onClick={() => setExpanded(expanded === server.id ? null : server.id)}
                  >
                    <td>
                      <span className="flex items-center gap-1.5">
                        <ChevronRight className={cx('size-3.5 text-faint transition-transform', expanded === server.id && 'rotate-90')} />
                        <span className="row-title">{server.name}</span>
                      </span>
                      <span className="row-sub mono">{server.url}</span>
                      {server.headerNames.length > 0 && <span className="row-sub mono">{server.headerNames.join(', ')}</span>}
                    </td>
                    <td>
                      <Badge tone={server.visibility === 'global' ? 'accent' : 'outline'}>{m.visibilities[server.visibility]}</Badge>
                    </td>
                    <td className="text-[12.5px]">
                      {server.toolsError ? (
                        <span className="text-danger">{server.toolsError}</span>
                      ) : server.tools ? (
                        m.tools(server.tools.length)
                      ) : (
                        <span className="text-faint">{m.noTools}</span>
                      )}
                    </td>
                    <td>
                      <ActiveBadge active={server.isActive} archived={Boolean(server.archivedAt)} />
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <span className="row-actions">
                        <Button size="sm" variant="ghost" disabled={refreshing === server.id} onClick={() => void refresh(server)}>
                          <RefreshCw className={cx(refreshing === server.id && 'spin')} />{' '}
                          {refreshing === server.id ? m.refreshing : m.refresh}
                        </Button>
                        <button
                          type="button"
                          className="row-action"
                          title={t.common.edit}
                          aria-label={t.common.edit}
                          onClick={() => setEditing(server)}
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          className="row-action danger"
                          title={t.common.remove}
                          aria-label={t.common.remove}
                          onClick={() => void remove(`/api/admin/ai/mcp-servers/${server.id}`, server.name, () => void reload())}
                        >
                          <Trash2 />
                        </button>
                      </span>
                    </td>
                  </tr>
                  {expanded === server.id && (
                    <tr>
                      <td colSpan={5} className="!bg-[var(--bg-sunken)]">
                        <p className="hint !mt-0">{m.visibilityHelp[server.visibility]}</p>
                        {server.toolsCachedAt && <p className="hint">{m.cachedAt(formatDateTime(server.toolsCachedAt))}</p>}
                        {server.toolsError && <p className="notice danger mt-2">{server.toolsError}</p>}
                        <McpInstructions server={server} />
                        {server.tools && server.tools.length > 0 ? (
                          <ul className="mt-2 grid gap-1.5">
                            {server.tools.map((tool) => (
                              <li key={tool.name} className="text-[12.5px]">
                                <span className="mono text-ink">{tool.name}</span>
                                {tool.annotations?.readOnlyHint && (
                                  <Badge tone="ok" className="ml-2">
                                    {m.readOnly}
                                  </Badge>
                                )}
                                {tool.annotations?.destructiveHint && (
                                  <Badge tone="danger" className="ml-2">
                                    {m.destructive}
                                  </Badge>
                                )}
                                {tool.description && <span className="block text-muted">{tool.description}</span>}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          !server.toolsError && <p className="hint">{m.noTools}</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <McpFormModal
          server={editing === 'new' ? null : editing}
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

/** O modo das instructions e o texto em cache (spec 022): avisa quando ele vai ao modelo. */
function McpInstructions({ server }: { server: McpServerDto }) {
  return (
    <div className="mt-2" data-testid="mcp-instructions">
      <p className="text-[12.5px]">
        <span className="font-medium">{m.instructionsMode}:</span> {m.instructionsModes[server.instructionsMode]}
      </p>
      {server.instructions ? (
        <>
          <p className={cx('notice mt-1', server.instructionsMode === 'ignore' ? '' : 'warn')}>
            {server.instructionsMode === 'ignore' ? m.instructionsIgnored : m.instructionsWarning}
          </p>
          <span className="label mt-2">{m.instructionsCached}</span>
          <pre className="panel contract-raw !max-h-[30vh]">{server.instructions}</pre>
        </>
      ) : (
        <p className="hint">{m.instructionsNone}</p>
      )}
    </div>
  );
}

type HeaderChange = { mode: 'keep' | 'replace' | 'remove'; value: string };

function McpFormModal({ server, onClose, onSaved }: { server: McpServerDto | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [visibility, setVisibility] = useState<McpVisibility>(server?.visibility ?? 'public');
  const [instructionsMode, setInstructionsMode] = useState<McpInstructionsMode>(server?.instructionsMode ?? 'ignore');
  const [isActive, setIsActive] = useState(server?.isActive ?? true);
  const [notes, setNotes] = useState(server?.notes ?? '');
  const [existing, setExisting] = useState<Record<string, HeaderChange>>(() =>
    Object.fromEntries((server?.headerNames ?? []).map((h) => [h, { mode: 'keep', value: '' }])),
  );
  const [added, setAdded] = useState<{ name: string; value: string }[]>(server ? [] : [{ name: 'Authorization', value: '' }]);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const fresh = Object.fromEntries(added.filter((h) => h.name.trim() && h.value).map((h) => [h.name.trim(), h.value]));
    let body: Record<string, unknown>;
    if (server) {
      const setHeaders: Record<string, string> = { ...fresh };
      const removeHeaders: string[] = [];
      for (const [header, change] of Object.entries(existing)) {
        if (change.mode === 'replace' && change.value) setHeaders[header] = change.value;
        if (change.mode === 'remove') removeHeaders.push(header);
      }
      body = { name: name.trim(), url: url.trim(), visibility, instructionsMode, isActive, notes, setHeaders, removeHeaders };
    } else {
      body = { name: name.trim(), url: url.trim(), visibility, instructionsMode, isActive, notes, headers: fresh };
    }
    const saved = await run(
      () =>
        server
          ? api.patch<McpServerDto>(`/api/admin/ai/mcp-servers/${server.id}`, body)
          : api.post<McpServerDto>('/api/admin/ai/mcp-servers', body),
      server ? m.saved : m.created,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={server ? m.edit : m.new} onClose={onClose} wide>
      <form onSubmit={submit} autoComplete="off">
        <div className="modal-body form-grid">
          <Field label={m.name}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
          <Field label={m.url} hint={m.urlHint}>
            <input
              className="field field-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://exemplo.com/mcp"
              required
              spellCheck={false}
            />
          </Field>
          <Field label={m.visibility} hint={m.visibilityHelp[visibility]}>
            <select className="field" value={visibility} onChange={(e) => setVisibility(e.target.value as McpVisibility)}>
              {(['global', 'public', 'private'] as const).map((v) => (
                <option key={v} value={v}>
                  {m.visibilities[v]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={m.instructionsMode} hint={m.instructionsModeHelp[instructionsMode]}>
            <select
              className="field"
              value={instructionsMode}
              onChange={(e) => setInstructionsMode(e.target.value as McpInstructionsMode)}
              data-testid="mcp-instructions-mode"
            >
              {MCP_INSTRUCTIONS_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {m.instructionsModes[mode]}
                </option>
              ))}
            </select>
          </Field>
          {server?.instructions && instructionsMode !== 'ignore' && <p className="notice warn mt-0">{m.instructionsWarning}</p>}
          <div>
            <span className="label">{m.headers}</span>
            <p className="hint !mt-0 mb-2">{m.headersHint}</p>
            <div className="grid gap-2">
              {Object.entries(existing).map(([header, change]) => (
                <div key={header} className="flex flex-wrap items-center gap-2">
                  <span className={cx('mono min-w-[140px] text-[12.5px]', change.mode === 'remove' && 'text-faint line-through')}>
                    {header}
                  </span>
                  {change.mode === 'replace' ? (
                    <input
                      className="field field-sm field-mono min-w-0 flex-1"
                      type="password"
                      value={change.value}
                      onChange={(e) => setExisting((all) => ({ ...all, [header]: { mode: 'replace', value: e.target.value } }))}
                      placeholder={m.newValue}
                      aria-label={`${m.newValue}: ${header}`}
                      autoComplete="new-password"
                    />
                  ) : (
                    <span className="mono flex-1 text-[12px] text-faint">••••••••</span>
                  )}
                  {change.mode === 'keep' ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExisting((all) => ({ ...all, [header]: { mode: 'replace', value: '' } }))}
                      >
                        {m.replace}
                      </Button>
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => setExisting((all) => ({ ...all, [header]: { mode: 'remove', value: '' } }))}
                      >
                        <Trash2 /> {m.removeHeader}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => setExisting((all) => ({ ...all, [header]: { mode: 'keep', value: '' } }))}
                    >
                      <Undo2 /> {m.keep}
                    </Button>
                  )}
                </div>
              ))}
              {added.map((header, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <input
                    className="field field-sm field-mono w-[160px]"
                    value={header.name}
                    onChange={(e) => setAdded((list) => list.map((h, i) => (i === index ? { ...h, name: e.target.value } : h)))}
                    placeholder={m.headerName}
                    aria-label={m.headerName}
                    spellCheck={false}
                  />
                  <input
                    className="field field-sm field-mono min-w-0 flex-1"
                    type="password"
                    value={header.value}
                    onChange={(e) => setAdded((list) => list.map((h, i) => (i === index ? { ...h, value: e.target.value } : h)))}
                    placeholder={m.headerValue}
                    aria-label={m.headerValue}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="row-action"
                    aria-label={m.removeHeader}
                    onClick={() => setAdded((list) => list.filter((_, i) => i !== index))}
                  >
                    <X />
                  </button>
                </div>
              ))}
            </div>
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAdded((list) => [...list, { name: '', value: '' }])}>
              <Plus /> {m.addHeader}
            </Button>
          </div>
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> {m.active}
          </label>
          <Field label={m.notes}>
            <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
