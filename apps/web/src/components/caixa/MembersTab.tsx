import { CAIXA_ROLES, type CaixaDetail, type MemberRow, t, type UserRow } from '@moneyflow/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, RoleBadge, SkelRows } from '../domain';
import { ModalActions } from '../forms';
import { Avatar, Button, EmptyRow, Field, Modal, Status, useConfirm } from '../ui';

type Role = (typeof CAIXA_ROLES)[number];

/** Quem acessa a caixa e com que papel (editor/leitor). Só o admin altera. */
export function MembersTab({ caixa }: { caixa: CaixaDetail }) {
  const me = useUser();
  const isAdmin = me.role === 'admin';
  const { data, error, reload, setData } = useApi<MemberRow[]>(`/api/caixas/${caixa.id}/members`);
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const { run } = useAction();

  async function changeRole(member: MemberRow, role: Role) {
    const rows = await run(() => api.patch<MemberRow[]>(`/api/caixas/${caixa.id}/members/${member.id}`, { role }), 'Papel atualizado.');
    if (rows) setData(rows);
  }

  async function remove(member: MemberRow) {
    const ok = await confirm({ title: `Remover @${member.username} da caixa?`, confirmLabel: t.common.remove, danger: true });
    if (!ok) return;
    const rows = await run(() => api.del<MemberRow[]>(`/api/caixas/${caixa.id}/members/${member.id}`), 'Membro removido.');
    if (rows) setData(rows);
  }

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[13px] text-muted">Administradores enxergam todas as caixas e não aparecem aqui.</p>
        {isAdmin && (
          <Button onClick={() => setAdding(true)}>
            <Plus /> Adicionar membro
          </Button>
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t.user.username}</th>
              <th>Papel na caixa</th>
              <th>{t.common.status}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!data && <SkelRows cols={4} rows={2} />}
            {data && data.length === 0 && <EmptyRow colSpan={4}>Nenhum membro.</EmptyRow>}
            {data?.map((member) => (
              <tr key={member.id} className={member.isActive ? '' : 'is-off'}>
                <td>
                  <span className="flex items-center gap-3">
                    <Avatar name={member.username} />
                    <span>
                      <span className="row-title">@{member.username}</span>
                      <span className="row-sub">{member.email}</span>
                    </span>
                  </span>
                </td>
                <td>
                  {isAdmin ? (
                    <select
                      className="field field-sm field-auto"
                      value={member.role}
                      onChange={(e) => void changeRole(member, e.target.value as Role)}
                      aria-label="Papel"
                    >
                      {CAIXA_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t.roles[role]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                </td>
                <td>{member.isActive ? <Status tone="ok">{t.user.active}</Status> : <Status tone="off">{t.user.inactive}</Status>}</td>
                <td className="text-right">
                  {isAdmin && (
                    <button type="button" className="row-action danger" title={t.common.remove} onClick={() => void remove(member)}>
                      <Trash2 />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <AddMemberModal
          caixaId={caixa.id}
          existing={new Set((data ?? []).map((m) => m.userId))}
          onClose={() => setAdding(false)}
          onSaved={(rows) => {
            setData(rows);
            setAdding(false);
          }}
        />
      )}
    </>
  );
}

function AddMemberModal({
  caixaId,
  existing,
  onClose,
  onSaved,
}: {
  caixaId: string;
  existing: Set<string>;
  onClose: () => void;
  onSaved: (rows: MemberRow[]) => void;
}) {
  const users = useApi<UserRow[]>('/api/users');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const { run, busy } = useAction();
  const options = (users.data ?? []).filter((u) => u.role !== 'admin' && !existing.has(u.id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const rows = await run(() => api.post<MemberRow[]>(`/api/caixas/${caixaId}/members`, { userId, role }), 'Membro adicionado.');
    if (rows) onSaved(rows);
  }

  return (
    <Modal open title="Adicionar membro" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={t.user.username}>
          <select className="field" value={userId} onChange={(e) => setUserId(e.target.value)} required autoFocus>
            <option value="">{users.loading ? t.common.loading : 'Escolha…'}</option>
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username} · {u.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Papel na caixa" hint="Editor lança e altera; leitor só consulta.">
          <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {CAIXA_ROLES.map((r) => (
              <option key={r} value={r}>
                {t.roles[r]}
              </option>
            ))}
          </select>
        </Field>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !userId}>
            {t.common.add}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
