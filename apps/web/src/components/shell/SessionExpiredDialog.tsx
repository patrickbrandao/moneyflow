import { t } from '@moneyflow/shared';
import { Lock, UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth, useUser } from '../../lib/auth';
import { Button, useEscapeLayer, useModalFocus } from '../ui';

const S = t.auth.expiredDialog;

/**
 * A sessão caiu com o console aberto (tarefa 119): esta janela pede o login
 * por cima de tudo, sem desmontar o console. O que estava sendo digitado
 * continua na tela, e os pedidos que receberam o 401 são repetidos se o mesmo
 * usuário entrar. Outro usuário recomeça o console limpo, na página inicial
 * (o App troca a `key` do console e volta para `/`).
 * Não fecha no Esc nem no clique fora: a camada dela segura o Esc para que
 * ele não feche o formulário de baixo.
 */
export function SessionExpiredDialog() {
  const user = useUser();
  const { login, logout } = useAuth();
  const [identifier, setIdentifier] = useState(user.username);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { card, trapTab } = useModalFocus(true);
  useEscapeLayer(true, () => {});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(identifier, password);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <>
      <div className="overlay" style={{ zIndex: 75 }} />
      <div
        ref={card}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
        tabIndex={-1}
        onKeyDown={trapTab}
        style={{ zIndex: 76 }}
        data-testid="session-expired"
      >
        <form onSubmit={submit}>
          <h2 id="session-expired-title">{S.title}</h2>
          <p className="d">{S.description}</p>
          <div className="login-field">
            <UserRound />
            <input
              type="text"
              name="login"
              className="field"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={t.auth.login}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-label={t.auth.login}
            />
          </div>
          <div className="login-field">
            <Lock />
            <input
              type="password"
              name="password"
              className="field"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t.auth.password}
              autoComplete="current-password"
              aria-label={t.auth.password}
              autoFocus
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="actions">
            <Button variant="ghost" onClick={() => void logout()}>
              {t.auth.logout}
            </Button>
            <Button type="submit" disabled={submitting || !identifier || !password}>
              {submitting ? t.auth.submitting : t.auth.submit}
            </Button>
          </div>
        </form>
      </div>
    </>,
    document.body,
  );
}
