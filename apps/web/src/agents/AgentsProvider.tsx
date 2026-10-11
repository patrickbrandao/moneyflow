import type { ConversationDto, ScreenContext } from '@moneyflow/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useStored } from '../lib/storage';

/*
 * Estado das janelas dos agentes (spec 011): várias janelas flutuantes (uma
 * por conversa), a doca de minimizadas e UM painel ancorado à direita. Tudo
 * vive acima das rotas (no Console) e vai para o localStorage, então sobrevive
 * à navegação e ao recarregamento. Também guarda o "contexto da tela" que as
 * páginas informam (useAgentScreenContext), enviado em cada mensagem.
 */

export type AgentWindow = {
  /** Id da conversa. */
  id: string;
  title: string | null;
  agentName: string;
  colorSlot: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
};

type UiState = {
  windows: AgentWindow[];
  /** Conversa ancorada no painel direito (null = sem painel). */
  docked: string | null;
  panelWidth: number;
  panelCollapsed: boolean;
};

export const PANEL_MIN = 320;
export const PANEL_MAX = 760;
const INITIAL: UiState = { windows: [], docked: null, panelWidth: 400, panelCollapsed: false };

export type WindowMeta = { id: string; title?: string | null; agentName?: string; colorSlot?: number };

type AgentsApi = {
  state: UiState;
  open: (meta: Required<Pick<WindowMeta, 'id'>> & WindowMeta) => void;
  close: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  focus: (id: string) => void;
  setGeometry: (id: string, geometry: Partial<Pick<AgentWindow, 'x' | 'y' | 'w' | 'h'>>) => void;
  dockRight: (id: string) => void;
  undock: (id: string) => void;
  setPanelWidth: (width: number) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  updateMeta: (meta: WindowMeta) => void;
  /** Cria a conversa (com o contexto da tela) e abre a janela. */
  createConversation: (agentId: string) => Promise<ConversationDto>;
  registerScreen: (key: number, context: ScreenContext | null) => void;
  screenContext: () => ScreenContext;
  /** Muda quando alguma conversa mudou (lista do ícone recarrega). */
  listVersion: number;
  bumpList: () => void;
};

const AgentsContext = createContext<AgentsApi | null>(null);

export function useAgents(): AgentsApi {
  const value = useContext(AgentsContext);
  if (!value) throw new Error('useAgents fora do AgentsProvider');
  return value;
}

export const conversationMeta = (c: ConversationDto): WindowMeta & { id: string } => ({
  id: c.id,
  title: c.title,
  agentName: c.agentName,
  colorSlot: c.agentColorSlot,
});

function clampGeometry(win: AgentWindow): AgentWindow {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const w = Math.max(320, Math.min(win.w, vw - 16));
  const h = Math.max(280, Math.min(win.h, vh - 16));
  const x = Math.max(8 - w + 120, Math.min(win.x, vw - 120));
  const y = Math.max(8, Math.min(win.y, vh - 48));
  return { ...win, w, h, x, y };
}

const STRING_MAX = { route: 500, title: 200, caixaName: 200 } as const;

/** Limpa o contexto para caber no schema da API (screenContextInput). */
function sanitize(context: ScreenContext): ScreenContext {
  const out: ScreenContext = {};
  if (context.route) out.route = context.route.slice(0, STRING_MAX.route);
  if (context.title) out.title = context.title.slice(0, STRING_MAX.title);
  if (context.caixaId && /^[0-9a-f-]{36}$/i.test(context.caixaId)) out.caixaId = context.caixaId;
  if (context.caixaName) out.caixaName = context.caixaName.slice(0, STRING_MAX.caixaName);
  if (context.record?.id) {
    out.record = {
      kind: context.record.kind.slice(0, 50),
      id: context.record.id.slice(0, 100),
      ...(context.record.label ? { label: context.record.label.slice(0, 300) } : {}),
    };
  }
  if (context.filters) {
    const filters: NonNullable<ScreenContext['filters']> = {};
    for (const [key, value] of Object.entries(context.filters).slice(0, 30)) {
      if (value === undefined) continue;
      filters[key.slice(0, 50)] = typeof value === 'string' ? value.slice(0, 300) : value;
    }
    if (Object.keys(filters).length > 0) out.filters = filters;
  }
  return out;
}

export function AgentsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useStored<UiState>('agents-ui', INITIAL);
  const [listVersion, setListVersion] = useState(0);
  const location = useLocation();
  const route = useRef('');
  route.current = `${location.pathname}${location.search}`;
  const screens = useRef(new Map<number, ScreenContext>());

  // Estado salvo de uma versão antiga ou corrompido: volta ao inicial.
  const safe: UiState = useMemo(() => (state && Array.isArray(state.windows) ? { ...INITIAL, ...state } : INITIAL), [state]);

  const update = useCallback(
    (fn: (s: UiState) => UiState) =>
      setState((current) => fn(current && Array.isArray(current.windows) ? { ...INITIAL, ...current } : INITIAL)),
    [setState],
  );

  const topZ = (s: UiState) => s.windows.reduce((max, w) => Math.max(max, w.z), 0) + 1;

  const open = useCallback<AgentsApi['open']>(
    (meta) =>
      update((s) => {
        const existing = s.windows.find((w) => w.id === meta.id);
        if (existing) {
          return {
            ...s,
            panelCollapsed: s.docked === meta.id ? false : s.panelCollapsed,
            windows: s.windows.map((w) =>
              w.id === meta.id
                ? {
                    ...w,
                    minimized: false,
                    z: topZ(s),
                    title: meta.title !== undefined ? meta.title : w.title,
                    agentName: meta.agentName ?? w.agentName,
                    colorSlot: meta.colorSlot ?? w.colorSlot,
                  }
                : w,
            ),
          };
        }
        const offset = s.windows.filter((w) => !w.minimized).length % 6;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.min(420, vw - 32);
        const h = Math.min(600, vh - 120);
        const win: AgentWindow = clampGeometry({
          id: meta.id,
          title: meta.title ?? null,
          agentName: meta.agentName ?? '',
          colorSlot: meta.colorSlot ?? 1,
          w,
          h,
          x: vw - w - 32 - offset * 28,
          y: Math.max(64, vh - h - 72 - offset * 28),
          z: topZ(s),
          minimized: false,
        });
        return { ...s, windows: [...s.windows, win] };
      }),
    [update],
  );

  const close = useCallback<AgentsApi['close']>(
    (id) => update((s) => ({ ...s, docked: s.docked === id ? null : s.docked, windows: s.windows.filter((w) => w.id !== id) })),
    [update],
  );

  const minimize = useCallback<AgentsApi['minimize']>(
    (id) =>
      update((s) => ({
        ...s,
        docked: s.docked === id ? null : s.docked,
        windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
      })),
    [update],
  );

  const restore = useCallback<AgentsApi['restore']>(
    (id) =>
      update((s) => ({
        ...s,
        panelCollapsed: s.docked === id ? false : s.panelCollapsed,
        windows: s.windows.map((w) => (w.id === id ? clampGeometry({ ...w, minimized: false, z: topZ(s) }) : w)),
      })),
    [update],
  );

  const focus = useCallback<AgentsApi['focus']>(
    (id) =>
      update((s) => {
        const win = s.windows.find((w) => w.id === id);
        if (!win || win.z === topZ(s) - 1) return s;
        return { ...s, windows: s.windows.map((w) => (w.id === id ? { ...w, z: topZ(s) } : w)) };
      }),
    [update],
  );

  const setGeometry = useCallback<AgentsApi['setGeometry']>(
    (id, geometry) => update((s) => ({ ...s, windows: s.windows.map((w) => (w.id === id ? clampGeometry({ ...w, ...geometry }) : w)) })),
    [update],
  );

  const dockRight = useCallback<AgentsApi['dockRight']>(
    (id) =>
      update((s) => ({
        ...s,
        docked: id,
        panelCollapsed: false,
        // O que estava ancorado volta para a doca.
        windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: false } : w.id === s.docked ? { ...w, minimized: true } : w)),
      })),
    [update],
  );

  const undock = useCallback<AgentsApi['undock']>(
    (id) =>
      update((s) => ({
        ...s,
        docked: s.docked === id ? null : s.docked,
        windows: s.windows.map((w) => (w.id === id ? clampGeometry({ ...w, minimized: false, z: topZ(s) }) : w)),
      })),
    [update],
  );

  const setPanelWidth = useCallback(
    (width: number) => update((s) => ({ ...s, panelWidth: Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, width))) })),
    [update],
  );
  const setPanelCollapsed = useCallback((collapsed: boolean) => update((s) => ({ ...s, panelCollapsed: collapsed })), [update]);

  const updateMeta = useCallback<AgentsApi['updateMeta']>(
    (meta) =>
      update((s) => {
        const win = s.windows.find((w) => w.id === meta.id);
        if (!win) return s;
        const next = {
          ...win,
          title: meta.title !== undefined ? meta.title : win.title,
          agentName: meta.agentName ?? win.agentName,
          colorSlot: meta.colorSlot ?? win.colorSlot,
        };
        if (next.title === win.title && next.agentName === win.agentName && next.colorSlot === win.colorSlot) return s;
        return { ...s, windows: s.windows.map((w) => (w.id === meta.id ? next : w)) };
      }),
    [update],
  );

  const registerScreen = useCallback((key: number, context: ScreenContext | null) => {
    if (context) screens.current.set(key, context);
    else screens.current.delete(key);
  }, []);

  const screenContext = useCallback((): ScreenContext => {
    // Quem informa um registro (gaveta, página de detalhe) vence quem só informa a caixa/filtros.
    const entries = [...screens.current.values()].sort((a, b) => Number(Boolean(a.record)) - Number(Boolean(b.record)));
    const merged: ScreenContext = { route: route.current };
    for (const entry of entries) {
      for (const [key, value] of Object.entries(entry)) {
        if (value === undefined) continue;
        if (key === 'filters') merged.filters = { ...merged.filters, ...(value as ScreenContext['filters']) };
        else (merged as Record<string, unknown>)[key] = value;
      }
    }
    if (!merged.title && typeof document !== 'undefined') merged.title = document.title;
    return sanitize(merged);
  }, []);

  const bumpList = useCallback(() => setListVersion((v) => v + 1), []);

  const createConversation = useCallback(
    async (agentId: string) => {
      const conversation = await api.post<ConversationDto>('/api/conversations', { agentId, screenContext: screenContext() });
      open(conversationMeta(conversation));
      bumpList();
      return conversation;
    },
    [open, screenContext, bumpList],
  );

  // Janela redimensionada: as janelas voltam para dentro da tela.
  useEffect(() => {
    const onResize = () => update((s) => ({ ...s, windows: s.windows.map(clampGeometry) }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [update]);

  const value = useMemo<AgentsApi>(
    () => ({
      state: safe,
      open,
      close,
      minimize,
      restore,
      focus,
      setGeometry,
      dockRight,
      undock,
      setPanelWidth,
      setPanelCollapsed,
      updateMeta,
      createConversation,
      registerScreen,
      screenContext,
      listVersion,
      bumpList,
    }),
    [
      safe,
      open,
      close,
      minimize,
      restore,
      focus,
      setGeometry,
      dockRight,
      undock,
      setPanelWidth,
      setPanelCollapsed,
      updateMeta,
      createConversation,
      registerScreen,
      screenContext,
      listVersion,
      bumpList,
    ],
  );

  // Link do sino ("agente concluiu"): ?conversation=<id> abre a janela da conversa.
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('conversation');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    open({ id });
    params.delete('conversation');
    const qs = params.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [location.search, location.pathname, open, navigate]);

  return <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>;
}

let screenSeq = 0;

/**
 * A página informa o que está na tela para o agente: caixa aberta, registro
 * selecionado, filtros e um título. A rota entra sozinha. Passe null enquanto
 * os dados não chegaram.
 */
export function useAgentScreenContext(context: Omit<ScreenContext, 'route'> | null) {
  const agents = useContext(AgentsContext);
  const key = useRef(0);
  if (key.current === 0) {
    screenSeq += 1;
    key.current = screenSeq;
  }
  const serialized = JSON.stringify(context);
  useEffect(() => {
    if (!agents) return;
    agents.registerScreen(key.current, context);
    return () => agents.registerScreen(key.current, null);
  }, [serialized, agents?.registerScreen]);
}
