import { t } from '@moneyflow/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type MouseEvent, type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { cx } from './ui';

/*
 * Acessibilidade das listas e das gavetas (tarefa 114). As linhas clicáveis
 * continuam abrindo pelo clique (o mouse), e o nome da linha vira o controle
 * focável que faz o mesmo: um link quando há rota, um botão quando abre uma
 * gaveta, uma janela ou um detalhe. O clique no controle não sobe para a
 * linha, para não abrir duas vezes.
 */

/** O nome da linha como link para a tela do registro. */
export function RowLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link className={cx('row-title', className)} to={to} onClick={(event) => event.stopPropagation()}>
      {children}
    </Link>
  );
}

/** O nome da linha como botão: abre a gaveta, a janela ou o detalhe do registro. */
export function RowButton({
  onClick,
  children,
  className,
  label,
}: {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  className?: string;
  /** Nome acessível quando o conteúdo sozinho não diz o que abre (ex.: só a data). */
  label?: string;
}) {
  return (
    <button
      type="button"
      className={cx('row-title row-button', className)}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
    >
      {children}
    </button>
  );
}

/** A seta de expandir a linha como botão, com `aria-expanded`. */
export function ExpandToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="report-caret row-toggle"
      aria-expanded={open}
      aria-label={open ? t.common.collapseItem(label) : t.common.expandItem(label)}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {open ? <ChevronDown /> : <ChevronRight />}
    </button>
  );
}

/**
 * Gaveta: ao abrir (e a cada registro novo), o foco vai para o título dela
 * (`tabIndex={-1}`); ao fechar, volta para onde estava (a linha que abriu).
 */
export function useDrawerFocus<T extends HTMLElement>(key: unknown): RefObject<T | null> {
  const heading = useRef<T | null>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  // O foco acompanha o registro mostrado (key).
  useEffect(() => {
    heading.current?.focus();
  }, [key]);
  return heading;
}
