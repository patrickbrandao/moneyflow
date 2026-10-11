import { t } from '@moneyflow/shared';
import { Lock, UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '../components/ui';
import { BRAND } from '../config/brand';
import { useAuth } from '../lib/auth';

/**
 * Entrar (spec 002): usuário OU e-mail e senha; a sessão vem num cookie
 * httpOnly. Não há autoatendimento de senha: quem esquece pede ao admin.
 *
 * Anatomia do template: cartão de 380px sobre o fundo pontilhado; marca,
 * título, campos com ícone, erro em faixa tingida, botão de largura total.
 */
export function LoginPage({ notice }: { notice?: string | null }) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  return (
    <div className="login-shell">
      <form onSubmit={submit} className="login-card">
        <div className="brand">
          <img src={BRAND.logoUrl} alt="" />
          <span>
            <span className="nm">{BRAND.name}</span>
            <br />
            <span className="sb">{BRAND.subtitle}</span>
          </span>
        </div>
        <h1>{t.auth.title}</h1>
        <p className="sub">{t.auth.subtitle}</p>

        <div className="login-field">
          <UserRound />
          <input
            type="text"
            name="login"
            className="field"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={t.auth.login}
            autoFocus
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
          />
        </div>

        {error && <p className="form-error">{error}</p>}
        {!error && notice && <p className="form-notice">{notice}</p>}

        <Button type="submit" disabled={submitting || !identifier || !password} className="mt-5 w-full">
          {submitting ? t.auth.submitting : t.auth.submit}
        </Button>

        <p className="login-note">{t.auth.forgot}</p>
      </form>
    </div>
  );
}
