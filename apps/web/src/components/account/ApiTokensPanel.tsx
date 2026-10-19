import { type ApiTokenCreated, type ApiTokenDto, formatDateTime, t } from '@moneyflow/shared';
import { KeySquare, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, CopyButton, cx, EmptyRow, Field, Modal, Panel, useConfirm } from '../ui';

const k = t.agentsUi.tokens;

export function tokenState(token: ApiTokenDto): { label: string; tone: 'ok' | 'outline' | 'danger' } {
  if (token.revokedAt) return { label: k.revoked, tone: 'danger' };
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return { label: k.expired, tone: 'outline' };
  return { label: k.active, tone: 'ok' };
}

/** Minha conta → Tokens de API: para o servidor MCP próprio (/mcp, Bearer), com as permissões de quem criou. */
export function ApiTokensPanel() {
  const { data, error, reload } = useApi<ApiTokenDto[]>('/api/account/api-tokens');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const mcpUrl = `${window.location.origin}/mcp`;

  async function revoke(token: ApiTokenDto) {
    const ok = await confirm({
      title: k.revokeConfirm(token.name),
      description: k.revokeDescription,
      confirmLabel: k.revoke,
      danger: true,
    });
    if (!ok) return;
    if (await run(() => api.del<ApiTokenDto>(`/api/account/api-tokens/${token.id}`), k.revokedOk)) void reload();
  }

  return (
    <Panel
      title={k.title}
      icon={<KeySquare />}
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> {k.new}
        </Button>
      }
    >
      <p className="panel-hint">{k.hint}</p>
      <div className="well mt-3">
        <span className="label">{k.mcpUrl}</span>
        <div className="flex items-center gap-2">
          <code className="mono min-w-0 flex-1 truncate text-[12.5px]">{mcpUrl}</code>
          <CopyButton text={mcpUrl} />
        </div>
        <p className="hint">{k.mcpAuth}</p>
      </div>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap mt-3">
          <table className="data">
            <thead>
              <tr>
                <th>{k.name}</th>
                <th>{k.created}</th>
                <th>{k.lastUsed}</th>
                <th>{k.expires}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={6} rows={2} />}
              {data?.length === 0 && <EmptyRow colSpan={6}>{k.empty}</EmptyRow>}
              {data?.map((token) => {
                const state = tokenState(token);
                return (
                  <tr key={token.id} className={cx(token.revokedAt && 'is-off')}>
                    <td>
                      <span className="row-title">{token.name}</span>
                      <span className="row-sub mono">{token.tokenPrefix}…</span>
                    </td>
                    <td className="mono text-xs">{formatDateTime(token.createdAt)}</td>
                    <td className="mono text-xs">
                      {token.lastUsedAt ? formatDateTime(token.lastUsedAt) : k.neverUsed}
                      {token.lastUsedIp && <span className="row-sub">{token.lastUsedIp}</span>}
                    </td>
                    <td className="mono text-xs">{token.expiresAt ? formatDateTime(token.expiresAt) : k.never}</td>
                    <td>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </td>
                    <td className="text-right">
                      {!token.revokedAt && (
                        <button
                          type="button"
                          className="row-action danger"
                          title={k.revoke}
                          aria-label={`${k.revoke} ${token.name}`}
                          onClick={() => void revoke(token)}
                        >
                          <Trash2 />
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
      {creating && (
        <CreateTokenModal
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
            void reload();
          }}
        />
      )}
      <Modal open={created !== null} title={k.createdTitle} onClose={() => setCreated(null)}>
        {created && (
          <>
            <div className="key-reveal">
              <p className="t">{k.createdWarn}</p>
              <div className="row">
                <code data-testid="api-token-value">{created.token}</code>
                <CopyButton text={created.token} label={t.common.copy} />
              </div>
            </div>
            <ModalActions>
              <Button onClick={() => setCreated(null)}>{k.done}</Button>
            </ModalActions>
          </>
        )}
      </Modal>
    </Panel>
  );
}

function CreateTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (token: ApiTokenCreated) => void }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const expiresInDays = days.trim() ? Number(days) : null;
    if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
      return setError(k.expiresInDays);
    }
    setError(null);
    const token = await run(() => api.post<ApiTokenCreated>('/api/account/api-tokens', { name: name.trim(), expiresInDays }));
    if (token) onCreated(token);
  }

  return (
    <Modal open title={k.new} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" autoComplete="off">
        <Field label={k.name}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={k.namePlaceholder}
            maxLength={120}
            required
            autoFocus
          />
        </Field>
        <Field label={k.expiresInDays} hint={k.expiresHint}>
          <input
            className="field field-mono"
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? t.common.saving : t.common.create}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
