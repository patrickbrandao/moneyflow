import { type AdminApiTokenDto, formatDateTime, type Membership, t, type UserRow } from '@moneyflow/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { tokenState } from '../components/account/ApiTokensPanel';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { FormError, ModalActions } from '../components/forms';
import { Badge, Button, CopyButton, cx, EmptyRow, Field, Modal, Panel, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';
import { NotFoundPage } from './NotFoundPage';

const k = t.agentsUi.tokens;
const m = t.agentsUi.mcpControl;

type Created = AdminApiTokenDto & { token: string };

const claudeCommand = (url: string, token: string) =>
  `claude mcp add --transport http moneyflow ${url} --header "Authorization: Bearer ${token}"`;

/** Os poderes que a chave herda do usuário: admin (tudo) ou as caixas com o papel em cada uma. */
function Powers({ role, active, memberships }: { role: string; active: boolean; memberships: Membership[] }) {
  if (!active) return <Badge tone="danger">{m.inactive}</Badge>;
  if (role === 'admin') return <Badge tone="accent">{m.adminPowers}</Badge>;
  if (memberships.length === 0) return <span className="text-faint text-xs">{m.noCaixas}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {memberships.map((membership) => (
        <Badge key={membership.caixaId} tone={membership.role === 'editor' ? 'ok' : 'outline'}>
          {t.roles[membership.role]} · {membership.caixaName}
        </Badge>
      ))}
    </span>
  );
}

/** Administração → Controle MCP (só admin): chaves do /mcp de qualquer usuário, com os poderes que elas herdam. */
export function AdminMcpPage() {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [userId, setUserId] = useParamState('user');
  const [revoked, setRevoked] = useParamState('revoked');
  const query = new URLSearchParams();
  if (userId) query.set('userId', userId);
  if (revoked) query.set('includeRevoked', 'true');
  const tokens = useApi<AdminApiTokenDto[]>(isAdmin ? `/api/admin/api-tokens?${query}` : null);
  const users = useApi<UserRow[]>(isAdmin ? '/api/users' : null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const mcpUrl = `${window.location.origin}/mcp`;
  if (!isAdmin) return <NotFoundPage />;

  async function revoke(token: AdminApiTokenDto) {
    const ok = await confirm({
      title: k.revokeConfirm(`${token.name} (${token.username})`),
      description: k.revokeDescription,
      confirmLabel: k.revoke,
      danger: true,
    });
    if (!ok) return;
    if (await run(() => api.del(`/api/admin/api-tokens/${token.id}`), k.revokedOk)) void tokens.reload();
  }

  return (
    <div className="page wide">
      <PageHead
        title={m.title}
        sub={m.sub}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> {m.new}
          </Button>
        }
      />

      <Panel title={m.howTitle} className="mb-4">
        <div className="well">
          <span className="label">{k.mcpUrl}</span>
          <div className="flex items-center gap-2">
            <code className="mono min-w-0 flex-1 truncate text-[12.5px]">{mcpUrl}</code>
            <CopyButton text={mcpUrl} />
          </div>
          <p className="hint">{m.howHint}</p>
          <code className="mono block text-[12px] break-all">{claudeCommand(mcpUrl, 'mf_…')}</code>
        </div>
        <p className="panel-hint mt-3">{m.powersHint}</p>
      </Panel>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select className="field max-w-xs" aria-label={m.user} value={userId ?? ''} onChange={(e) => setUserId(e.target.value || null)}>
          <option value="">{m.allUsers}</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <label className="check text-[13px]">
          <input type="checkbox" checked={Boolean(revoked)} onChange={(e) => setRevoked(e.target.checked ? '1' : null)} />
          {m.includeRevoked}
        </label>
      </div>

      {tokens.error ? (
        <LoadError error={tokens.error} onRetry={() => void tokens.reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{k.name}</th>
                <th>{m.user}</th>
                <th>{m.powers}</th>
                <th>{k.created}</th>
                <th>{k.lastUsed}</th>
                <th>{k.expires}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!tokens.data && <SkelRows cols={8} rows={3} />}
              {tokens.data?.length === 0 && <EmptyRow colSpan={8}>{m.empty}</EmptyRow>}
              {tokens.data?.map((token) => {
                const state = tokenState(token);
                return (
                  <tr key={token.id} className={cx(token.revokedAt && 'is-off')} data-testid="mcp-key-row">
                    <td>
                      <span className="row-title">{token.name}</span>
                      <span className="row-sub mono">{token.tokenPrefix}…</span>
                    </td>
                    <td>
                      <span className="row-title">{token.username}</span>
                      <span className="row-sub">{t.roles[token.userRole]}</span>
                    </td>
                    <td className="max-w-[360px]">
                      <Powers role={token.userRole} active={token.userActive} memberships={token.memberships} />
                    </td>
                    <td className="mono text-xs">
                      {formatDateTime(token.createdAt)}
                      {token.createdBy && <span className="row-sub">{m.createdBy(token.createdBy)}</span>}
                    </td>
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
        <CreateKeyModal
          users={users.data ?? []}
          initialUserId={userId}
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
            void tokens.reload();
          }}
        />
      )}
      <Modal open={created !== null} title={created ? m.createdTitle(created.username) : ''} onClose={() => setCreated(null)}>
        {created && (
          <>
            <div className="key-reveal">
              <p className="t">{k.createdWarn}</p>
              <div className="row">
                <code data-testid="mcp-key-value">{created.token}</code>
                <CopyButton text={created.token} label={t.common.copy} />
              </div>
            </div>
            <div className="well mt-3">
              <span className="label">{m.claudeCommand}</span>
              <div className="flex items-start gap-2">
                <code className="mono min-w-0 flex-1 text-[12px] break-all">{claudeCommand(mcpUrl, created.token)}</code>
                <CopyButton text={claudeCommand(mcpUrl, created.token)} />
              </div>
            </div>
            <ModalActions>
              <Button onClick={() => setCreated(null)}>{k.done}</Button>
            </ModalActions>
          </>
        )}
      </Modal>
    </div>
  );
}

function CreateKeyModal({
  users,
  initialUserId,
  onClose,
  onCreated,
}: {
  users: UserRow[];
  initialUserId: string | null;
  onClose: () => void;
  onCreated: (token: Created) => void;
}) {
  const active = users.filter((u) => u.isActive);
  const [userId, setUserId] = useState(active.some((u) => u.id === initialUserId) ? initialUserId! : '');
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const owner = active.find((u) => u.id === userId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const expiresInDays = days.trim() ? Number(days) : null;
    if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
      return setError(k.expiresInDays);
    }
    setError(null);
    const token = await run(() => api.post<Created>('/api/admin/api-tokens', { userId, name: name.trim(), expiresInDays }));
    if (token) onCreated(token);
  }

  return (
    <Modal open title={m.new} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" autoComplete="off">
        <Field label={m.user}>
          <select className="field" value={userId} onChange={(e) => setUserId(e.target.value)} required autoFocus>
            <option value="">{m.pickUser}</option>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username} ({t.roles[u.role]})
              </option>
            ))}
          </select>
        </Field>
        {owner && (
          <div>
            <span className="label">{m.powers}</span>
            <Powers role={owner.role} active={owner.isActive} memberships={owner.memberships} />
          </div>
        )}
        <Field label={k.name}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={k.namePlaceholder}
            maxLength={120}
            required
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
          <Button type="submit" disabled={busy || !userId || !name.trim()}>
            {busy ? t.common.saving : t.common.create}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
