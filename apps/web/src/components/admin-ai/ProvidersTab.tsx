import {
  AI_CAPABILITIES,
  AI_KIND_CAPABILITIES,
  AI_MODEL_SUGGESTIONS,
  type AiCapability,
  type AiDefaultModels,
  type AiProviderDto,
  type AiProviderKind,
  type AiProviderTestResult,
  t,
} from '@moneyflow/shared';
import { Pencil, PlugZap, Plus, Server, Trash2 } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, cx, EmptyRow, EmptyState, Field, Modal, useConfirm } from '../ui';
import { ActiveBadge, CAPABILITY_ICONS, CapabilityIcons, useProviderModels, useRemove } from './shared';

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
      .catch(
        (err: Error) => ({ ok: false, message: err.message, models: [], modelsUnavailable: false, checks: [] }) as AiProviderTestResult,
      );
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
                <th>{p.capabilities}</th>
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
                      <Link
                        to={`/admin/ai/providers/${provider.id}`}
                        className="row-title"
                        title={p.openDetail(provider.name)}
                        data-testid="provider-detail-link"
                      >
                        {provider.name}
                      </Link>
                      {provider.baseUrl && <span className="row-sub mono">{provider.baseUrl}</span>}
                      {provider.logBodies && (
                        <span className="mt-1 block">
                          <Badge tone="warn">{p.logsBodies}</Badge>
                        </span>
                      )}
                      {result && result !== 'loading' && (
                        <span className={cx('row-sub', result.ok ? 'text-ok' : 'text-danger')} data-testid="provider-test-result">
                          {result.ok ? p.testOk : `${p.testFail}: ${result.message}`}
                          {result.ok && result.models.length > 0 && ` · ${p.models(result.models.length)}`}
                          {result.modelsUnavailable && ` · ${p.modelsUnavailable}`}
                        </span>
                      )}
                      {result && result !== 'loading' && result.checks.length > 0 && (
                        <span className="capability-checks" data-testid="provider-test-checks">
                          {result.checks.map((check) => {
                            const Icon = CAPABILITY_ICONS[check.capability];
                            return (
                              <span
                                key={check.capability}
                                className={cx('flex items-center gap-1.5', check.ok ? 'text-dim' : 'text-danger')}
                                data-capability={check.capability}
                                data-ok={check.ok}
                              >
                                <Icon size={12} /> {t.agents.capabilities[check.capability]}
                                {check.model && <span className="mono text-faint">{check.model}</span>}· {check.message}
                              </span>
                            );
                          })}
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
                    <td>
                      <CapabilityIcons capabilities={provider.capabilities} />
                    </td>
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

/** Cadastro e edição do provedor (também usado pelo botão Editar do detalhe). */
export function ProviderFormModal({
  provider,
  onClose,
  onSaved,
}: {
  provider: AiProviderDto | null;
  onClose: () => void;
  onSaved: (saved: AiProviderDto) => void;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [kind, setKind] = useState<AiProviderKind>(provider?.kind ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [capabilities, setCapabilities] = useState<AiCapability[]>(provider?.capabilities ?? [...AI_KIND_CAPABILITIES.anthropic]);
  const [models, setModels] = useState<AiDefaultModels>(provider?.defaultModels ?? {});
  // Cache e raciocínio (Messages API): null = o padrão do banco (ligados sem base_url), até o admin mexer.
  const [promptCache, setPromptCache] = useState<boolean | null>(provider ? provider.promptCacheEnabled : null);
  const [thinking, setThinking] = useState<boolean | null>(provider ? provider.thinkingEnabled : null);
  const [isActive, setIsActive] = useState(provider?.isActive ?? true);
  const [logBodies, setLogBodies] = useState(provider?.logBodies ?? false);
  const [notes, setNotes] = useState(provider?.notes ?? '');
  const confirm = useConfirm();
  const allowed = AI_KIND_CAPABILITIES[kind];
  const compatible = kind === 'anthropic' && baseUrl.trim() !== '';

  /** Ligar o registro dos corpos pede confirmação (spec 023): leva conversas e dados financeiros. */
  async function toggleLogBodies(next: boolean) {
    if (next) {
      const ok = await confirm({ title: p.logBodiesWarnTitle, description: p.logBodiesWarn, confirmLabel: p.logBodiesConfirm });
      if (!ok) return;
    }
    setLogBodies(next);
  }

  /** Trocar o tipo (só no cadastro) volta as flags ao padrão dele, com as sugestões de modelo da OpenAI. */
  function changeKind(next: AiProviderKind) {
    setKind(next);
    setCapabilities([...AI_KIND_CAPABILITIES[next]]);
    setModels((current) =>
      next === 'openai'
        ? {
            embeddings: AI_MODEL_SUGGESTIONS.embeddings,
            transcription: AI_MODEL_SUGGESTIONS.transcription,
            speech: AI_MODEL_SUGGESTIONS.speech,
            speech_voice: AI_MODEL_SUGGESTIONS.speech_voice,
            ...current,
          }
        : { ...(current.text ? { text: current.text } : {}), ...(current.vision ? { vision: current.vision } : {}) },
    );
  }

  function toggleCapability(capability: AiCapability, on: boolean) {
    setCapabilities((current) => AI_CAPABILITIES.filter((c) => (c === capability ? on : current.includes(c))));
  }

  const setModel = (key: keyof AiDefaultModels, value: string) => setModels((current) => ({ ...current, [key]: value }));
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (compatible && capabilities.includes('text') && !models.text?.trim()) return setError(t.agents.errors.compatibleTextModel);
    setError(null);
    // Só os modelos das flags marcadas (a voz, com texto→áudio).
    const defaultModels = Object.fromEntries(
      Object.entries(models)
        .map(([key, value]) => [key, (value ?? '').trim()])
        .filter(([key, value]) => value && capabilities.includes((key === 'speech_voice' ? 'speech' : key) as AiCapability)),
    );
    const common = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      capabilities,
      defaultModels,
      ...(kind === 'anthropic' && promptCache !== null ? { promptCacheEnabled: promptCache } : {}),
      ...(kind === 'anthropic' && thinking !== null ? { thinkingEnabled: thinking } : {}),
      isActive,
      logBodies,
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
    if (saved) onSaved(saved);
  }

  const placeholders: Record<AiCapability, string> = {
    text: kind === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5',
    vision: models.text?.trim() || p.visionSameAsText,
    embeddings: AI_MODEL_SUGGESTIONS.embeddings,
    transcription: AI_MODEL_SUGGESTIONS.transcription,
    speech: AI_MODEL_SUGGESTIONS.speech,
  };

  return (
    <Modal open title={provider ? p.edit : p.new} onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="modal-body form-grid">
          <Field label={p.name}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
          <Field label={p.kind}>
            <select
              className="field"
              value={kind}
              onChange={(e) => changeKind(e.target.value as AiProviderKind)}
              disabled={Boolean(provider)}
              data-testid="provider-kind"
            >
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
          <fieldset className="admin-ai-section" data-testid="provider-capabilities">
            <legend>{p.capabilities}</legend>
            <p className="hint !mt-0 mb-2">{p.capabilitiesHint}</p>
            <div className="provider-capabilities">
              <span />
              <span className="label !mb-0">{p.defaultModel}</span>
              {AI_CAPABILITIES.map((capability) => {
                const enabled = allowed.includes(capability);
                const on = capabilities.includes(capability);
                const Icon = CAPABILITY_ICONS[capability];
                const required = capability === 'text' && compatible;
                const label = t.agents.capabilities[capability]!;
                return (
                  <Fragment key={capability}>
                    <label className="check" title={enabled ? undefined : p.capabilityOnlyOpenai}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!enabled}
                        onChange={(e) => toggleCapability(capability, e.target.checked)}
                        data-testid={`provider-cap-${capability}`}
                      />
                      <Icon size={13} /> {label}
                    </label>
                    {on ? (
                      <span className="flex gap-2">
                        <span className="min-w-0 flex-1">
                          <input
                            className="field field-mono"
                            value={models[capability] ?? ''}
                            onChange={(e) => setModel(capability, e.target.value)}
                            placeholder={placeholders[capability]}
                            required={required}
                            spellCheck={false}
                            aria-label={`${required ? p.defaultModelRequired : p.defaultModel}: ${label}`}
                            data-testid={`provider-model-${capability}`}
                          />
                        </span>
                        {capability === 'speech' && (
                          <span className="w-28 shrink-0">
                            <input
                              className="field field-mono"
                              value={models.speech_voice ?? ''}
                              onChange={(e) => setModel('speech_voice', e.target.value)}
                              placeholder={AI_MODEL_SUGGESTIONS.speech_voice}
                              spellCheck={false}
                              aria-label={p.speechVoice}
                              title={p.speechVoice}
                              data-testid="provider-voice"
                            />
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="self-center text-xs text-faint">{enabled ? '—' : p.capabilityOnlyOpenai}</span>
                    )}
                  </Fragment>
                );
              })}
            </div>
            {compatible && <p className="hint">{p.defaultModelRequired}</p>}
          </fieldset>
          {kind === 'anthropic' && (
            <div data-testid="provider-features">
              <span className="label">{p.features}</span>
              <div className="flex flex-wrap gap-4">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={promptCache ?? !compatible}
                    onChange={(e) => setPromptCache(e.target.checked)}
                    data-testid="provider-prompt-cache"
                  />{' '}
                  {p.promptCache}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={thinking ?? !compatible}
                    onChange={(e) => setThinking(e.target.checked)}
                    data-testid="provider-thinking"
                  />{' '}
                  {p.thinking}
                </label>
              </div>
              <p className="mt-1 text-xs text-muted">{p.featuresHint}</p>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> {t.agentsUi.admin.active}
          </label>
          <div>
            <label className="check">
              <input
                type="checkbox"
                checked={logBodies}
                onChange={(e) => void toggleLogBodies(e.target.checked)}
                data-testid="provider-log-bodies"
              />{' '}
              {p.logBodies}
            </label>
            <p className="mt-1 text-xs text-muted">{p.logBodiesHint}</p>
          </div>
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
