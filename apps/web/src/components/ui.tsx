import { Check, Copy } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

/* ============================================================
   Primitivos do console. Todo o visual é classe de CSS
   (base.css/shell.css); estes componentes só juntam as classes
   e cuidam do comportamento (foco, Esc, clique fora).
   ============================================================ */

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger';

export function Button({
  children,
  variant = 'primary',
  size,
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)}>
      {children}
    </button>
  );
}

/** Um link com cara de botão (navegação interna). */
export function ButtonLink({
  to,
  children,
  variant = 'ghost',
  size,
  className,
}: {
  to: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  return (
    <Link to={to} className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)}>
      {children}
    </Link>
  );
}

export function Panel({
  children,
  className = '',
  title,
  icon,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={cx('panel', className)}>
      {title && (
        <div className="panel-head mb-3">
          <h2 className="!mb-0">
            {icon}
            {title}
          </h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'outline';

export function Badge({
  tone = 'neutral',
  mono,
  title,
  children,
  className,
}: {
  tone?: Tone;
  mono?: boolean;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx('badge', tone !== 'neutral' && tone, mono && 'mono', className)} title={title}>
      {children}
    </span>
  );
}

export function Status({
  tone,
  pulse,
  children,
  title,
}: {
  tone: 'ok' | 'off' | 'warn' | 'danger';
  pulse?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`status ${tone}`} title={title}>
      <span className={cx('dot', pulse && 'pulse')} />
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('empty', className)}>
      {icon}
      <p className="t">{title}</p>
      {description && <p className="d">{description}</p>}
      {action}
    </div>
  );
}

/** A linha única de uma tabela sem itens: o cabeçalho continua no lugar. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan}>
        <p className="list-empty">{children}</p>
      </td>
    </tr>
  );
}

/** Esqueleto com a forma do conteúdo que vai chegar. */
export function Skel({
  h = 16,
  w,
  className,
  style,
}: {
  h?: number | string;
  w?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={cx('skel', className)} style={{ height: h, width: w, ...style }} aria-hidden />;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      window.prompt('Copie:', text);
    }
  };
  if (!label) {
    return (
      <button type="button" className="row-action" title={copied ? 'Copiado' : 'Copiar'} onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </button>
    );
  }
  return (
    <Button variant="ghost" size="sm" onClick={() => void copy()} aria-live="polite">
      {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : label}
    </Button>
  );
}

/* ---- ícone em ladrilho e avatar ---- */

/** Duas letras: as iniciais das duas primeiras palavras, ou as duas primeiras letras. */
export function initials(text: string): string {
  const words = text
    .replace(/[-_.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Matizes roxos (250°–320°) ficam de fora: o acento é azul e o roxo não é cor da marca. */
const PURPLE_HUE_START = 250;
const PURPLE_HUE_SPAN = 70;

/**
 * Matiz estável a partir do texto, fora da faixa roxa; saturação e luz fixas
 * para ler bem nos dois temas.
 */
export function monogramColor(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const raw = Math.abs(hash) % (360 - PURPLE_HUE_SPAN);
  const hue = raw < PURPLE_HUE_START ? raw : raw + PURPLE_HUE_SPAN;
  return `hsl(${hue} 42% 40%)`;
}

/**
 * Ícone de entidade num ladrilho de 36px (28 no `sm`, 48 no `lg`): URL de
 * imagem, emoji, ou — sem nenhum — o monograma colorido pelo nome.
 */
export function TileIcon({ icon, name, size, className }: { icon?: string | null; name: string; size?: 'sm' | 'lg'; className?: string }) {
  const [broken, setBroken] = useState(false);
  const classes = cx('tile-icon', size, className);
  if (icon && !broken) {
    if (/^(https?:)?\//.test(icon)) {
      return (
        <span className={classes} title={name}>
          <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />
        </span>
      );
    }
    return (
      <span className={classes} title={name} aria-hidden>
        {icon}
      </span>
    );
  }
  return (
    <span className={cx(classes, 'mono-tile')} title={name} style={{ background: monogramColor(name) }} aria-hidden>
      <span className="mono">{initials(name)}</span>
    </span>
  );
}

/** Avatar redondo: a foto, ou o monograma no gradiente do acento. */
export function Avatar({ name, src, size }: { name: string; src?: string | null; size?: 'lg' | 'xl' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    return <img className={cx('avatar', size)} src={src} alt="" aria-hidden onError={() => setFailed(true)} />;
  }
  return (
    <span className={cx('avatar', size)} aria-hidden>
      {initials(name)}
    </span>
  );
}

/* ---- abas ---- */
export type TabItem = { key: string; label: string; count?: number; icon?: ReactNode; to?: string };

export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange?: (key: string) => void;
  className?: string;
}) {
  // Numa tela estreita a barra rola para o lado: a guia ativa fica à vista.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !active) return;
    const box = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < box.left) el.scrollLeft += tab.left - box.left - 16;
    else if (tab.right > box.right) el.scrollLeft += tab.right - box.right + 16;
  }, [value]);

  return (
    <div ref={bar} className={cx('tabs', className)} role="tablist">
      {items.map((item) => {
        const body = (
          <>
            {item.icon}
            {item.label}
            {item.count !== undefined && <span className="count">{item.count}</span>}
          </>
        );
        return item.to ? (
          <Link key={item.key} to={item.to} role="tab" aria-selected={value === item.key} className={value === item.key ? 'active' : ''}>
            {body}
          </Link>
        ) : (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={value === item.key}
            className={value === item.key ? 'active' : ''}
            onClick={() => onChange?.(item.key)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

/* ---- menu flutuante (popover) ---- */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOutside();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('keydown', onEscape);
    };
  }, [ref, onOutside, active]);
}

const MenuContext = createContext<{ close: () => void }>({ close: () => {} });

export type MenuTrigger = (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;

export function Menu({
  trigger,
  align = 'left',
  children,
  className,
  up,
}: {
  trigger: MenuTrigger;
  align?: 'left' | 'right';
  children: ReactNode;
  className?: string /** Abre para cima (rodapé da sidebar). */;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  return (
    <div className={cx('menu-anchor', className)} ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div
          className={cx('menu', align === 'right' && 'right')}
          role="menu"
          style={up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  icon,
  onSelect,
  to,
  href,
  danger,
  disabled,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  to?: string;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { close } = useContext(MenuContext);
  const className = cx('mi', danger && 'danger');
  const handle = () => {
    close();
    onSelect?.();
  };
  if (to) {
    return (
      <Link to={to} className={className} role="menuitem" onClick={handle}>
        {icon}
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className} role="menuitem" onClick={handle}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} role="menuitem" onClick={handle} disabled={disabled}>
      {icon}
      {children}
    </button>
  );
}

export const MenuSeparator = () => <div className="sep" role="separator" />;
export const MenuHeading = ({ children }: { children: ReactNode }) => <div className="hd">{children}</div>;

/* ---- foco das janelas modais ---- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openerOutside(card: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || card?.contains(active)) return null;
  return active;
}

/**
 * O que uma janela modal precisa e o CSS não dá: foco inicial dentro dela, Tab
 * circulando por dentro e o foco devolvido a quem abriu ao fechar. Um
 * `autoFocus` no conteúdo tem prioridade.
 */
function useModalFocus(open: boolean) {
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let opener = openerOutside(card.current);
    // A paleta devolve o foco num setTimeout(0) ao fechar; o foco inicial
    // daqui só fica de pé se vier depois disso.
    const timer = setTimeout(() => {
      const el = card.current;
      if (!el) return;
      opener ??= openerOutside(el);
      if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const el = card.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (active === first || active === el)) {
      event.preventDefault();
      last.focus();
    }
  }, []);

  return { card, trapTab };
}

/* ---- confirmação (no lugar do window.confirm) ---- */
type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => true);

export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const { card, trapTab } = useModalFocus(pending !== null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })), []);

  const settle = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') settle(false);
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <>
          <div className="overlay" style={{ zIndex: 58 }} onClick={() => settle(false)} />
          <div
            ref={card}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            tabIndex={-1}
            onKeyDown={trapTab}
          >
            <h2 id="confirm-title">{pending.options.title}</h2>
            {pending.options.description && <p className="d">{pending.options.description}</p>}
            <div className="actions">
              <Button variant="ghost" onClick={() => settle(false)} autoFocus>
                {pending.options.cancelLabel ?? 'Cancelar'}
              </Button>
              <Button variant={pending.options.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
                {pending.options.confirmLabel ?? 'Confirmar'}
              </Button>
            </div>
          </div>
        </>
      )}
    </ConfirmContext.Provider>
  );
}

/* ---- modal genérico ---- */
export function Modal({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const { card, trapTab } = useModalFocus(open);

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open, onClose]);

  if (!open) return null;
  // Portal no <body>: aberto de dentro de uma gaveta, o modal não herda o empilhamento dela.
  return createPortal(
    <>
      <div className="overlay" style={{ zIndex: 58 }} onClick={onClose} />
      <div
        ref={card}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
        style={wide ? { width: 'min(640px, calc(100vw - 2rem))' } : undefined}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </>,
    document.body,
  );
}

/* ---- ganchos utilitários ---- */

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Repete `fn` a cada `ms` enquanto a aba estiver visível. */
export function usePolling(fn: () => void | Promise<void>, ms: number, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void latest.current();
    };
    tick();
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
}
