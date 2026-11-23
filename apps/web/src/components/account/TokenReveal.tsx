import { t } from '@moneyflow/shared';
import type { ReactNode } from 'react';
import { ModalActions } from '../forms';
import { Button, CopyButton, Field, Modal } from '../ui';

/*
 * O que a chave do /mcp tem igual em Minha conta → Tokens de API e em
 * Administração → Controle MCP (tarefa 182): a validade em dias e a janela que
 * mostra a chave uma única vez.
 */

const k = t.agentsUi.tokens;

/** Validade em dias digitada: vazio = sem validade; senão um inteiro de 1 a 3650 (o mesmo do `apiTokenCreateInput`). */
export function expiresInDaysOf(days: string): { value: number | null; error: string | null } {
  if (!days.trim()) return { value: null, error: null };
  const value = Number(days);
  if (!Number.isInteger(value) || value < 1 || value > 3650) return { value: null, error: k.expiresInDays };
  return { value, error: null };
}

/** O campo da validade em dias (só dígitos). */
export function ExpiresInDaysField({ value, onChange }: { value: string; onChange: (days: string) => void }) {
  return (
    <Field label={k.expiresInDays} hint={k.expiresHint}>
      <input className="field field-mono" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
    </Field>
  );
}

/** A chave recém-criada, mostrada uma vez, com o copiar; `children` acrescenta o que for da tela (o comando do Claude). */
export function TokenRevealModal({
  title,
  token,
  testId,
  onClose,
  children,
}: {
  title: string;
  token: string | null;
  testId: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open={token !== null} title={title} onClose={onClose}>
      {token && (
        <>
          <div className="key-reveal">
            <p className="t">{k.createdWarn}</p>
            <div className="row">
              <code data-testid={testId}>{token}</code>
              <CopyButton text={token} label={t.common.copy} />
            </div>
          </div>
          {children}
          <ModalActions>
            <Button onClick={onClose}>{k.done}</Button>
          </ModalActions>
        </>
      )}
    </Modal>
  );
}
