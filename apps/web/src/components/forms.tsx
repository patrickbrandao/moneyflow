import { type CategoryNode, type EntitySummary, formatCents, formatDocument, parseBRL, t } from '@moneyflow/shared';
import { Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { CategoryDot } from './domain';
import { cx, useClickOutside, useDebounced } from './ui';

/* Campos de formulário do domínio: dinheiro, entidade, categoria, conta. */

/** Valor em BRL digitado em pt-BR ("1.234,56"); devolve centavos (ou null se vazio/inválido). */
export function MoneyInput({
  value,
  onChange,
  id,
  placeholder = '0,00',
  allowNegative,
  autoFocus,
  ariaLabel,
}: {
  value: number | null;
  onChange: (cents: number | null) => void;
  id?: string;
  placeholder?: string;
  allowNegative?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value === null ? '' : formatCents(value));
  const emitted = useRef<number | null>(value);
  // Valor trocado de fora (ex.: preencher o saldo aberto): reescreve o texto.
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setText(value === null ? '' : formatCents(value));
    }
  }, [value]);
  const invalid = text.trim() !== '' && (parseBRL(text) === null || (!allowNegative && (parseBRL(text) ?? 0) < 0));
  return (
    <input
      id={id}
      className="field field-mono"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        setText(event.target.value);
        const cents = parseBRL(event.target.value);
        const next = cents === null || (!allowNegative && cents < 0) ? null : cents;
        emitted.current = next;
        onChange(next);
      }}
      onBlur={() => {
        const cents = parseBRL(text);
        if (cents !== null) setText(formatCents(cents));
      }}
    />
  );
}

export type EntityOption = { id: string; name: string; document?: string | null };

/** Busca de entidade (trigram na API) com lista suspensa. */
export function EntityPicker({
  value,
  onChange,
  placeholder = 'Buscar entidade por nome ou documento…',
  autoFocus,
  ariaLabel,
}: {
  value: EntityOption | null;
  onChange: (value: EntityOption | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<EntitySummary[]>([]);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query, 200);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .get<EntitySummary[]>('/api/entities', { q: debounced.trim() || undefined, limit: 8 })
      .then((rows) => {
        if (!cancelled) {
          setOptions(rows);
          setActive(0);
        }
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [debounced, open]);

  if (value) {
    return (
      <div className="picker">
        <div className="picked">
          <input className="field" value={value.name} readOnly aria-label={ariaLabel} />
          <button type="button" className="icon-btn" title="Trocar" aria-label="Trocar entidade" onClick={() => onChange(null)}>
            <X />
          </button>
        </div>
      </div>
    );
  }

  const pick = (entity: EntitySummary) => {
    onChange({ id: entity.id, name: entity.name, document: entity.document });
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="picker" ref={ref}>
      <label className="search-bar w-full">
        <Search />
        <input
          className="field w-full"
          value={query}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-label={ariaLabel ?? placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, options.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter' && open && options[active]) {
              event.preventDefault();
              pick(options[active]);
            }
          }}
        />
      </label>
      {open && (
        <div className="menu" role="listbox">
          {options.length === 0 && <div className="hd">{t.common.noResults}</div>}
          {options.map((entity, index) => (
            <button
              key={entity.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={cx('mi', index === active && 'bg-s2')}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(entity)}
            >
              <span className="min-w-0 flex-1 truncate text-left">{entity.name}</span>
              {entity.document && <span className="mono text-[11px] text-faint">{formatDocument(entity.document)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lista plana (grupo › sub) de categorias do tipo pedido, sem as ocultas na caixa (mantém a atual). */
export function useCategoryOptions(kind: 'income' | 'expense', caixaId?: string | null) {
  const tree = useApi<CategoryNode[]>(`/api/categories?kind=${kind}${caixaId ? `&caixaId=${caixaId}` : ''}`);
  return useMemo(() => {
    const out: { id: string; label: string; slot: number | null; hidden: boolean; isGroup: boolean }[] = [];
    for (const group of tree.data ?? []) {
      out.push({ id: group.id, label: group.name, slot: group.colorSlot, hidden: group.hidden, isGroup: true });
      for (const child of group.children) {
        out.push({
          id: child.id,
          label: `${group.name} › ${child.name}`,
          slot: child.colorSlot ?? group.colorSlot,
          hidden: child.hidden,
          isGroup: false,
        });
      }
    }
    return { options: out, loading: tree.loading };
  }, [tree.data, tree.loading]);
}

export function CategorySelect({
  kind,
  caixaId,
  value,
  onChange,
  allowEmpty,
  ariaLabel,
}: {
  kind: 'income' | 'expense';
  caixaId?: string | null;
  value: string | null;
  onChange: (id: string | null) => void;
  allowEmpty?: string;
  ariaLabel?: string;
}) {
  const { options } = useCategoryOptions(kind, caixaId);
  const selected = options.find((o) => o.id === value);
  return (
    <div className="flex items-center gap-2">
      <CategoryDot slot={selected?.slot} />
      <select className="field" value={value ?? ''} onChange={(event) => onChange(event.target.value || null)} aria-label={ariaLabel}>
        <option value="">{allowEmpty ?? 'Escolha…'}</option>
        {options
          .filter((o) => !o.hidden || o.id === value)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
      </select>
    </div>
  );
}

/** Mensagem de erro de formulário (validação local ou da API). */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="notice danger mt-3">{children}</p>;
}

/** Barra de ações no fim do modal. */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}
