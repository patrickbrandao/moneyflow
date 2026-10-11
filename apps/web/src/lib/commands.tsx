import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Registro de comandos: toda ação do console existe primeiro como comando e só
 * depois como botão. Cada tela registra os seus ao montar e remove ao
 * desmontar; a paleta (⌘K) lista o que está registrado agora.
 */

export type CommandGroup = 'Criar' | 'Ir para' | 'Recurso' | 'Conta' | 'Perigo';

export const GROUP_ORDER: CommandGroup[] = ['Criar', 'Ir para', 'Recurso', 'Conta', 'Perigo'];

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  icon?: ReactNode;
  /** Sinônimos que a pessoa pode digitar. */
  keywords?: string[];
  /** Só exibição ("a", "g f"); quem liga a tecla é a tela. */
  shortcut?: string;
  /** Motivo, quando desabilitado: aparece esmaecido em vez de sumir. */
  disabled?: string | false;
  danger?: boolean;
  run: () => void | Promise<void>;
};

type CommandApi = {
  commands: Command[];
  isOpen: boolean;
  open: () => void;
  close: () => void;
  register: (commands: Command[]) => () => void;
};

const CommandContext = createContext<CommandApi>({
  commands: [],
  isOpen: false,
  open: () => {},
  close: () => {},
  register: () => () => {},
});

let nextRegistration = 1;

export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Map<number, Command[]>>(() => new Map());
  const [isOpen, setOpen] = useState(false);

  const register = useCallback((commands: Command[]) => {
    const id = nextRegistration++;
    setRegistry((current) => new Map(current).set(id, commands));
    return () => {
      setRegistry((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    };
  }, []);

  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  // ⌘K / Ctrl+K abre (ou fecha) a paleta em qualquer tela.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const commands = useMemo(() => [...registry.values()].flat(), [registry]);
  const api = useMemo<CommandApi>(() => ({ commands, isOpen, open, close, register }), [commands, isOpen, open, close, register]);
  return <CommandContext.Provider value={api}>{children}</CommandContext.Provider>;
}

/**
 * Registra comandos enquanto o componente estiver montado. `deps` decide quando
 * reescrever a lista; sem o cleanup, ações de telas fechadas ficariam na
 * paleta e falhariam ao executar.
 */
export function useRegisterCommands(commands: Command[], deps: unknown[]) {
  const { register } = useContext(CommandContext);
  const latest = useRef(commands);
  latest.current = commands;
  useEffect(() => register(latest.current), [register, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePalette() {
  const { open, close, isOpen } = useContext(CommandContext);
  return { open, close, isOpen };
}

export function useCommandRegistry() {
  return useContext(CommandContext);
}

/**
 * Casamento aproximado: cada caractere da busca aparece em ordem no texto;
 * pontua mais quando casa no início de palavra. `includes` não basta — quem
 * digita "nv flx" espera "Novo fluxo".
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 3 + (t.startsWith(q) ? 1 : 0);
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return 0;
    score += at === 0 || t[at - 1] === ' ' || t[at - 1] === '-' ? 2 : 1;
    ti = at + 1;
  }
  return score / (q.length * 2 + 1);
}

/* ---- teclado ---- */

/**
 * O alvo do teclado é um campo de digitação? Só texto, `textarea`, `select` e
 * `contenteditable` capturam letras; caixa de marcar e botão não — senão Esc e
 * os atalhos morreriam depois de clicar numa caixa.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(type);
  }
  return false;
}

/** Janela do acorde "g + tecla". */
const CHORD_MS = 800;
let chordAt = 0;
let chordEvent: KeyboardEvent | null = null;

/** Arma o acorde (chamado ao soltar o `g`). */
export function armChord() {
  chordAt = Date.now();
}

/**
 * Esta tecla é a segunda de um acorde "g x"? Atalhos de uma letra só (o "a" de
 * adicionar no canvas) consultam isto para não disparar em "g a". A mesma
 * pergunta feita duas vezes para o mesmo evento responde igual.
 */
export function isChordKey(event: KeyboardEvent): boolean {
  if (chordEvent === event) return true;
  chordEvent = null;
  if (Date.now() - chordAt > CHORD_MS) return false;
  chordAt = 0;
  chordEvent = event;
  return true;
}
