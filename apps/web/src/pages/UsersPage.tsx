import { CAIXA_ROLES, type CaixaSummary, formatDateTime, GLOBAL_ROLES, type Membership, t, type UserRow } from '@moneyflow/shared';
import { Eye, EyeOff, KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserCheck, UserX } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { LoadError, PageHead, RoleBadge, SkelRows } from '../components/domain';
import { FormError, ModalActions } from '../components/forms';
import { Avatar, Button, CopyButton, EmptyRow, Field, Modal, Status, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

/**
 * Usuários (só admin, spec 002): criar, editar, ativar/desativar, revelar a
 * senha (única exibição permitida) e papéis por caixa.
 */
export function UsersPage() {
  const me = useUser();
  const [isNew, setNew] = useParamState('new');
  const { data, error, reload } = useApi<UserRow[]>(me.role === 'admin' ? '/api/users' : null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [roles, setRoles] = useState<UserRow | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const confirm = useConfirm();
  const { run } = useAction();

  useRegisterCommands([{ id: 'user-new', label: t.palette.newUser, group: 'Criar', icon: <Plus />, run: () => setNew('1') }], []);

  if (me.role !== 'admin') return <Navigate to="/" replace />;

  async function toggleActive(user: UserRow) {
    if (user.isActive) {
      const ok = await confirm({
        title: `Desativar @${user.username}?`,
        description: 'As sessões abertas dele terminam na hora.',
        confirmLabel: 'Desativar',
        danger: true,
      });
      if (!ok) return;
    }
    if (
      await run(
        () => api.patch(`/api/users/${user.id}`, { isActive: !user.isActive }),
        user.isActive ? 'Usuário desativado.' : 'Usuário ativado.',
      )
    )
      void reload();
  }

  async function remove(user: UserRow) {
    const ok = await confirm({
      title: `Excluir @${user.username}?`,
      description: 'Prefira desativar: a exclusão é definitiva.',
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (ok && (await run(() => api.del(`/api/users/${user.id}`), 'Usuário excluído.'))) void reload();
  }

  async function reveal(user: UserRow) {
    if (revealed[user.id] !== undefined) {
      setRevealed(({ [user.id]: _, ...rest }) => rest);
      return;
    }
    const result = await run(() => api.post<{ password: string }>(`/api/users/${user.id}/reveal-password`));
    if (result) setRevealed((r) => ({ ...r, [user.id]: result.password }));
  }

  return (
    <div className="page wide">
      <PageHead
        title={t.nav.users}
        sub="Quem acessa o MoneyFlow, o papel global e o papel em cada caixa."
        actions={
          <Button onClick={() => setNew('1')}>
            <Plus /> {t.palette.newUser}
          </Button>
        }
      />
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.user.username}</th>
                <th>{t.user.role}</th>
                <th>{t.user.memberships}</th>
                <th>{t.common.status}</th>
                <th>{t.user.lastLogin}</th>
                <th>{t.user.password}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={7} />}
              {data && data.length === 0 && <EmptyRow colSpan={7}>Nenhum usuário.</EmptyRow>}
              {data?.map((user) => (
                <tr key={user.id} className={user.isActive ? '' : 'is-off'}>
                  <td>
                    <span className="flex items-center gap-3">
                      <Avatar name={user.username} />
                      <span>
                        <span className="row-title">@{user.username}</span>
                        <span className="row-sub">{user.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="text-[12.5px] text-dim">
                    {user.role === 'admin'
                      ? 'todas'
                      : user.memberships.length === 0
                        ? '—'
                        : user.memberships.map((m) => `${m.caixaName} (${t.roles[m.role]?.toLowerCase()})`).join(', ')}
                  </td>
                  <td>{user.isActive ? <Status tone="ok">{t.user.active}</Status> : <Status tone="off">{t.user.inactive}</Status>}</td>
                  <td className="mono text-xs">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</td>
                  <td>
                    <span className="inline-flex items-center gap-1">
                      <span className="mono text-xs">{revealed[user.id] ?? '••••••'}</span>
                      <button
                        type="button"
                        className="row-action"
                        title={revealed[user.id] !== undefined ? t.user.hidePassword : t.user.revealPassword}
                        onClick={() => void reveal(user)}
                      >
                        {revealed[user.id] !== undefined ? <EyeOff /> : <Eye />}
                      </button>
                      {revealed[user.id] !== undefined && <CopyButton text={revealed[user.id]!} />}
                    </span>
                  </td>
                  <td className="text-right">
                    <span className="row-actions">
                      <button type="button" className="row-action" title={t.common.edit} onClick={() => setEditing(user)}>
                        <Pencil />
                      </button>
                      {user.role !== 'admin' && (
                        <button type="button" className="row-action" title={t.user.memberships} onClick={() => setRoles(user)}>
                          <ShieldCheck />
                        </button>
                      )}
                      {user.id !== me.id && (
                        <>
                          <button
                            type="button"
                            className="row-action"
                            title={user.isActive ? 'Desativar' : 'Ativar'}
                            onClick={() => void toggleActive(user)}
                          >
                            {user.isActive ? <UserX /> : <UserCheck />}
                          </button>
                          <button type="button" className="row-action danger" title={t.common.delete} onClick={() => void remove(user)}>
                            <Trash2 />
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(isNew || editing) && (
        <UserModal
          user={editing}
          onClose={() => {
            setNew(null);
            setEditing(null);
          }}
          onSaved={() => {
            setNew(null);
            setEditing(null);
            void reload();
          }}
        />
      )}
      {roles && (
        <MembershipsModal
          user={roles}
          onClose={() => setRoles(null)}
          onSaved={() => {
            setRoles(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function UserModal({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<(typeof GLOBAL_ROLES)[number]>(user?.role ?? 'user');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!user && password.length < 6) return setError('A senha precisa de ao menos 6 caracteres.');
    setError(null);
    const body = { username, email, role, ...(password ? { password } : {}) };
    const ok = await run(
      () => (user ? api.patch(`/api/users/${user.id}`, body) : api.post('/api/users', body)),
      user ? 'Usuário atualizado.' : 'Usuário criado.',
    );
    if (ok) onSaved();
  }

  return (
    <Modal open title={user ? `Editar @${user.username}` : t.palette.newUser} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={t.user.username} hint="Sem espaços nem @.">
          <input className="field" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus autoComplete="off" />
        </Field>
        <Field label={t.user.email}>
          <input type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </Field>
        <Field
          label={user ? `${t.user.newPassword} (${t.common.optional})` : t.user.password}
          hint={user ? 'Trocar a senha encerra as sessões dele.' : undefined}
        >
          <input
            type="text"
            className="field field-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label={t.user.role}>
          <select className="field" value={role} onChange={(e) => setRole(e.target.value as (typeof GLOBAL_ROLES)[number])}>
            {GLOBAL_ROLES.map((r) => (
              <option key={r} value={r}>
                {t.roles[r]}
              </option>
            ))}
          </select>
        </Field>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function MembershipsModal({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const [roles, setRoles] = useState<Record<string, Membership['role'] | ''>>(() =>
    Object.fromEntries(user.memberships.map((m) => [m.caixaId, m.role])),
  );
  const { run, busy } = useAction();

  async function save() {
    const memberships = Object.entries(roles)
      .filter(([, role]) => role)
      .map(([caixaId, role]) => ({ caixaId, role }));
    if (await run(() => api.put(`/api/users/${user.id}/memberships`, { memberships }), 'Papéis atualizados.')) onSaved();
  }

  return (
    <Modal open title={`${t.user.memberships} · @${user.username}`} onClose={onClose} wide>
      <div className="modal-body">
        <p className="d mb-3">Editor lança e altera; leitor só consulta. Sem papel, a caixa não aparece para ele.</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Caixa</th>
                <th>Papel</th>
              </tr>
            </thead>
            <tbody>
              {!caixas.data && <SkelRows cols={2} rows={3} />}
              {caixas.data?.map((caixa) => (
                <tr key={caixa.id}>
                  <td>
                    <span className="row-title">{caixa.name}</span>
                    <span className="row-sub">{caixa.holderName}</span>
                  </td>
                  <td>
                    <select
                      className="field field-sm field-auto"
                      value={roles[caixa.id] ?? ''}
                      onChange={(e) => setRoles((r) => ({ ...r, [caixa.id]: e.target.value as Membership['role'] | '' }))}
                      aria-label={`Papel em ${caixa.name}`}
                    >
                      <option value="">Sem acesso</option>
                      {CAIXA_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t.roles[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          <KeyRound /> {t.common.save}
        </Button>
      </ModalActions>
    </Modal>
  );
}
