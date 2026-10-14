import { t } from '@moneyflow/shared';
import { KeyRound, UserRound, Wallet } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { AiSettingsPanel } from '../components/account/AiSettingsPanel';
import { AiUsagePanel } from '../components/account/AiUsagePanel';
import { ApiTokensPanel } from '../components/account/ApiTokensPanel';
import { RoleBadge } from '../components/domain';
import { FormError } from '../components/forms';
import { Avatar, Button, Field, Panel } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useAction } from '../lib/hooks';

/** Minha conta: dados, caixas a que tenho acesso, troca de senha, IA (spec 022), o meu uso de IA (spec 028) e tokens de API. */
export function AccountPage() {
  const user = useUser();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 6) return setError('A nova senha precisa de ao menos 6 caracteres.');
    if (next !== confirmNext) return setError('A confirmação não confere com a nova senha.');
    setError(null);
    const ok = await run(() => api.post('/api/auth/password', { currentPassword: current, newPassword: next }), t.user.passwordChanged);
    if (ok) {
      setCurrent('');
      setNext('');
      setConfirmNext('');
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <div className="flex items-center gap-4">
          <Avatar name={user.name} size="xl" />
          <div>
            <h1>@{user.username}</h1>
            <p className="sub">{user.email}</p>
            <div className="mt-2">
              <RoleBadge role={user.role} />
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-4">
        <Panel title="Dados da conta" icon={<UserRound />}>
          <dl className="kv">
            <dt>{t.user.username}</dt>
            <dd className="mono">@{user.username}</dd>
            <dt>{t.user.email}</dt>
            <dd>{user.email}</dd>
            <dt>{t.user.role}</dt>
            <dd>{t.roles[user.role]}</dd>
          </dl>
          <p className="panel-hint mt-3">Para mudar usuário ou e-mail, peça a um administrador.</p>
        </Panel>
        <Panel title={t.user.memberships} icon={<Wallet />}>
          {user.role === 'admin' ? (
            <p className="panel-hint">Administradores acessam todas as caixas.</p>
          ) : user.memberships.length === 0 ? (
            <p className="panel-hint">Você ainda não tem acesso a nenhuma caixa.</p>
          ) : (
            <div className="item-list">
              {user.memberships.map((m) => (
                <div key={m.caixaId} className="item">
                  <Link className="link grow" to={`/caixas/${m.caixaId}`}>
                    {m.caixaName}
                  </Link>
                  <RoleBadge role={m.role} />
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title={t.user.changePassword} icon={<KeyRound />}>
          <form onSubmit={submit} className="form-grid">
            <p className="panel-hint">Trocar a senha encerra as sessões abertas nos outros aparelhos.</p>
            <Field label={t.user.currentPassword}>
              <input
                type="password"
                className="field"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
            <div className="form-grid cols-2">
              <Field label={t.user.newPassword}>
                <input
                  type="password"
                  className="field"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirme a nova senha">
                <input
                  type="password"
                  className="field"
                  value={confirmNext}
                  onChange={(e) => setConfirmNext(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <FormError>{error}</FormError>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !current || !next}>
                {busy ? t.common.saving : t.user.changePassword}
              </Button>
            </div>
          </form>
        </Panel>
        <AiSettingsPanel />
        <AiUsagePanel />
        <ApiTokensPanel />
      </div>
    </div>
  );
}
