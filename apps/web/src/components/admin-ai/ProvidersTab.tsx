import { type AiProviderDto, type AiProviderKind, type AiProviderTestResult, t } from '@moneyflow/shared';
import { Pencil, PlugZap, Plus, Server, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, cx, EmptyRow, EmptyState, Field, Modal } from '../ui';
import { ActiveBadge, useProviderModels, useRemove } from './shared';

const p = t.agentsUi.admin.providers;

/** Provedores de IA: Anthropic ou OpenAI-compatível; a chave é write-only (só a dica "…abcd"). */
export function ProvidersTab() {
  const { data, error, reload } = useApi<AiProviderDto[]>('/api/admin/ai/providers');
  const [editing, setEditing] = useState<AiProviderDto | 'new' | null>(null);
  const [tests, setTests] = useState<Record<string, AiProviderTestResult | 'loading'>>({});
  const [, setModels] = useProviderModels();
  const remove = useRemove();

  async function test(provider: AiProviderDto) {
    setTests((all) => ({ ...all, [provider.id]: 'loading' }));
    const result = await api
      .post<AiProviderTestResult>(`/api/admin/ai/providers/${provider.id}/test`)
      .catch((err: Error) => ({ ok: false, message: err.message, models: [] }) as AiProviderTestResult);
    setTests((all) => ({ ...all, [provider.id]: result }));
    if (result.ok && result.models.length) setModels((all) => ({ ...all, [provider.id]: result.models }));
  }

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus /> {p.new}
        </Button>
      </div>
      {data && data.length === 0 ? (
        <EmptyState
          icon={<Server />}
          title={p.empty}
          description={p.emptyHint}
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus /> {p.new}
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{p.name}</th>
                <th>{p.kind}</th>
                <th>{p.key}</th>
                <th>{p.embeddingModel}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={6} />}
              {data?.length === 0 && <EmptyRow colSpan={6}>{p.empty}</EmptyRow>}
              {data?.map((provider) => {
                const result = tests[provider.id];
                return (
                  <tr key={provider.id} className={cx(provider.archivedAt && 'is-off')}>
                    <td>
                      <span className="row-title">{provider.name}</span>
                      {provider.baseUrl && <span className="row-sub mono">{provider.baseUrl}</span>}
                      {result && result !== 'loading' && (
                        <span className={cx('row-sub', result.ok ? 'text-ok' : 'text-danger')}>
                          {result.ok ? p.testOk : `${p.testFail}: ${result.message}`}
                          {result.ok && result.models.length > 0 && ` · ${p.models(result.models.length)}`}
                        </span>
                      )}
                      {result && result !== 'loading' && result.models.length > 0 && (
                        <span className="mt-1 flex max-w-[520px] flex-wrap gap-1">
                          {result.models.slice(0, 40).map((m) => (
                            <Badge key={m} tone="outline" mono>
                              {m}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>{p.kinds[provider.kind]}</td>
                    <td className="mono text-xs">{provider.apiKeyHint ?? '—'}</td>
                    <td className="mono text-xs">{provider.embeddingModel ?? '—'}</td>
                    <td>
                      <ActiveBadge active={provider.isActive} archived={Boolean(provider.archivedAt)} />
                    </td>
                    <td className="text-right">
                      <span className="row-actions">
                        <Button size="sm" variant="ghost" disabled={result === 'loading'} onClick={() => void test(provider)}>
                          <PlugZap /> {result === 'loading' ? p.testing : p.test}
                        </Button>
                        <button
                          type="button"
                          className="row-action"
                          title={t.common.edit}
                          aria-label={t.common.edit}
                          onClick={() => setEditing(provider)}
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          className="row-action danger"
                          title={t.common.remove}
                          aria-label={t.common.remove}
                          onClick={() => void remove(`/api/admin/ai/providers/${provider.id}`, provider.name, () => void reload())}
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
        <ProviderFormModal
          provider={editing === 'new' ? null : editing}
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

function ProviderFormModal({ provider, onClose, onSaved }: { provider: AiProviderDto | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(provider?.name ?? '');
  const [kind, setKind] = useState<AiProviderKind>(provider?.kind ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState(provider?.embeddingModel ?? '');
  const [isActive, setIsActive] = useState(provider?.isActive ?? true);
  const [notes, setNotes] = useState(provider?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const common = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      embeddingModel: kind === 'openai' ? embeddingModel.trim() : '',
      isActive,
      notes,
    };
    const saved = await run(
      () =>
        provider
          ? api.patch<AiProviderDto>(`/api/admin/ai/providers/${provider.id}`, {
              ...common,
              apiKey: apiKey.trim() || undefined,
              clearApiKey: clearApiKey && !apiKey.trim(),
            })
          : api.post<AiProviderDto>('/api/admin/ai/providers', { ...common, kind, apiKey: apiKey.trim() }),
      provider ? p.saved : p.created,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={provider ? p.edit : p.new} onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="modal-body form-grid">
          <Field label={p.name}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
          <Field label={p.kind}>
            <select className="field" value={kind} onChange={(e) => setKind(e.target.value as AiProviderKind)} disabled={Boolean(provider)}>
              <option value="anthropic">{p.kinds.anthropic}</option>
              <option value="openai">{p.kinds.openai}</option>
            </select>
          </Field>
          <Field label={p.baseUrl} hint={p.baseUrlHint}>
            <input
              className="field field-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={kind === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
              spellCheck={false}
            />
          </Field>
          <Field
            label={p.apiKey}
            hint={provider ? `${provider.apiKeyHint ? p.apiKeySaved(provider.apiKeyHint) : p.apiKeyNone} ${p.apiKeyKeep}` : undefined}
          >
            <input
              className="field field-mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider?.apiKeyHint ? '••••••••' : 'sk-…'}
              autoComplete="new-password"
              spellCheck={false}
              aria-label={p.apiKey}
            />
          </Field>
          {provider?.apiKeyHint && (
            <label className="check">
              <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} disabled={Boolean(apiKey)} />{' '}
              {p.clearApiKey}
            </label>
          )}
          {kind === 'openai' && (
            <Field label={p.embeddingModel} hint={p.embeddingHint}>
              <input
                className="field field-mono"
                value={embeddingModel}
                onChange={(e) => setEmbeddingModel(e.target.value)}
                placeholder="text-embedding-3-small"
                spellCheck={false}
              />
            </Field>
          )}
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> {t.agentsUi.admin.active}
          </label>
          <Field label={p.notes}>
            <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
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
