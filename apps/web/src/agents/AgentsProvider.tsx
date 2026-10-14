import type { ConversationDetail, ConversationDto, ScreenContext } from '@moneyflow/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useStored } from '../lib/storage';

/*
 * Estado das janelas dos agentes (specs 011 e 026): uma janela flutuante por
 * AGENTE (sempre na sessão ativa do fio), janelas de leitura para as sessões
 * finalizadas (ou de outro usuário, para o admin), a doca de minimizadas e UM
 * painel ancorado à direita. Tudo vive acima das rotas (no Console) e vai para
 * o localStorage, então sobrevive à navegação e ao recarregamento. Também
 * guarda o "contexto da tela" que as páginas informam (useAgentScreenContext),
 * enviado em cada mensagem.
 */

export type AgentWindow = {
  /** Chave da janela: o id do agente (kind agent) ou o da sessão (kind session). */
  id: string;
  /** agent = a janela do fio (sessão ativa); session = leitura de uma sessão fixa. */
  kind: 'agent' | 'session';
  agentId: string;
  /** A sessão mostrada: na janela do agente, a ativa (null = a próxima mensagem cria); na de leitura, a fixa. */
  conversationId: string | null;
  title: string | null;
  agentName: string;
  colorSlot: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  /** Modo áudio (spec 025): play nas mensagens de texto. Desligado por padrão, por janela. */
  audioMode?: boolean;
  /** Janela salva por uma versão anterior (por conversa): convertida na leitura, quando a API responde. */
  legacy?: boolean;
};

type UiState = {
  /** 2 = janelas por agente (spec 026); sem versão = por conversa (convertido na leitura). */
  v?: 2;
  windows: AgentWindow[];
  /** Janela ancorada no painel direito (null = sem painel). */
  docked: string | null;
  panelWidth: number;
  panelCollapsed: boolean;
};

export const PANEL_MIN = 320;
export const PANEL_MAX = 760;
const INITIAL: UiState = { v: 2, windows: [], docked: null, panelWidth: 400, panelCollapsed: false };

export type WindowMeta = {
  id: string;
  kind?: AgentWindow['kind'];
  agentId?: string;
  conversationId?: string | null;
  title?: string | null;
  agentName?: string;
  colorSlot?: number;
};

type AgentsApi = {
  state: UiState;
  /** Abre (ou traz para a frente) a janela do agente, na sessão ativa. */
  openAgent: (meta: { agentId: string; agentName?: string; colorSlot?: number; title?: string | null }) => void;
  /** Abre uma sessão: a ativa do próprio usuário vai para a janela do agente; as outras, numa janela de leitura. */
  openConversation: (conversation: ConversationDto) => void;
  /** Abre a sessão pelo id (link do sino, requisições do admin). */
  openById: (conversationId: string) => Promise<void>;
  close: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  focus: (id: string) => void;
  setGeometry: (id: string, geometry: Partial<Pick<AgentWindow, 'x' | 'y' | 'w' | 'h'>>) => void;
  dockRight: (id: string) => void;
  undock: (id: string) => void;
  setPanelWidth: (width: number) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  setAudioMode: (id: string, on: boolean) => void;
  updateMeta: (meta: WindowMeta) => void;
  registerScreen: (key: number, context: ScreenContext | null) => void;
  screenContext: () => ScreenContext;
  /** Muda quando alguma sessão mudou (lista do ícone recarrega). */
  listVersion: number;
  bumpList: () => void;
  /** Muda quando a sessão ativa de um fio mudou por fora da janela (bifurcar, excluir): as janelas dos agentes relêem. */
  sessionsVersion: number;
  bumpSessions: () => void;
};

const AgentsContext = createContext<AgentsApi | null>(null);

export function useAgents(): AgentsApi {
  const value = useContext(AgentsContext);
  if (!value) throw new Error('useAgents fora do AgentsProvider');
  return value;
}

/** Meta da janela de leitura de uma sessão. */
export const sessionMeta = (c: ConversationDto): WindowMeta => ({
  id: c.id,
  kind: 'session',
  agentId: c.agentId,
  conversationId: c.id,
  title: c.title,
  agentName: c.agentName,
  colorSlot: c.agentColorSlot,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normaliza o estado salvo: o de uma versão antiga (janelas por conversa, sem
 * `kind`) vira janelas de leitura marcadas como `legacy`, que o provider
 * converte em janelas por agente assim que a API diz de quem é cada sessão.
 */
export function normalizeUiState(raw: unknown): UiState {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as UiState).windows)) return INITIAL;
  const state = { ...INITIAL, ...(raw as UiState) };
  const windows: AgentWindow[] = [];
  for (const w of state.windows as Partial<AgentWindow>[]) {
    if (!w || typeof w.id !== 'string' || !UUID.test(w.id)) continue;
    const base = {
      title: w.title ?? null,
      agentName: w.agentName ?? '',
      colorSlot: w.colorSlot ?? 1,
      x: Number(w.x) || 0,
      y: Number(w.y) || 0,
      w: Number(w.w) || 420,
      h: Number(w.h) || 600,
      z: Number(w.z) || 1,
      minimized: Boolean(w.minimized),
      ...(w.audioMode ? { audioMode: true } : {}),
    };
    if (w.kind === 'agent' || w.kind === 'session') {
      windows.push({
        ...base,
        id: w.id,
        kind: w.kind,
        agentId: w.agentId ?? (w.kind === 'agent' ? w.id : ''),
        conversationId: w.conversationId ?? (w.kind === 'session' ? w.id : null),
        ...(w.legacy ? { legacy: true } : {}),
      });
    } else {
      // Versão anterior: a janela era de uma conversa (id = conversa).
      windows.push({ ...base, id: w.id, kind: 'session', agentId: '', conversationId: w.id, legacy: true });
    }
  }
  const docked = state.docked && windows.some((w) => w.id === state.docked) ? state.docked : null;
  return { v: 2, windows, docked, panelWidth: state.panelWidth, panelCollapsed: state.panelCollapsed };
}

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
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const me = useUser().id;
  const location = useLocation();
  const route = useRef('');
  route.current = `${location.pathname}${location.search}`;
  const screens = useRef(new Map<number, ScreenContext>());

  // Estado salvo de uma versão antiga (convertido) ou corrompido (volta ao inicial).
  const safe: UiState = useMemo(() => normalizeUiState(state), [state]);

  const update = useCallback((fn: (s: UiState) => UiState) => setState((current) => fn(normalizeUiState(current))), [setState]);

  const topZ = (s: UiState) => s.windows.reduce((max, w) => Math.max(max, w.z), 0) + 1;

  const open = useCallback(
    (meta: WindowMeta & { kind: AgentWindow['kind']; agentId: string }) =>
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
                    conversationId: meta.conversationId !== undefined ? meta.conversationId : w.conversationId,
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
          kind: meta.kind,
          agentId: meta.agentId,
          conversationId: meta.conversationId ?? (meta.kind === 'session' ? meta.id : null),
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

  const openAgent = useCallback<AgentsApi['openAgent']>(
    (meta) =>
      open({
        id: meta.agentId,
        kind: 'agent',
        agentId: meta.agentId,
        agentName: meta.agentName,
        colorSlot: meta.colorSlot,
        ...(meta.title !== undefined ? { title: meta.title } : {}),
      }),
    [open],
  );

  const openConversation = useCallback<AgentsApi['openConversation']>(
    (c) => {
      if (c.userId === me && !c.archivedAt) {
        open({ id: c.agentId, kind: 'agent', agentId: c.agentId, agentName: c.agentName, colorSlot: c.agentColorSlot, title: c.title });
      } else {
        open({ ...sessionMeta(c), kind: 'session', agentId: c.agentId });
      }
    },
    [open, me],
  );

  const openById = useCallback<AgentsApi['openById']>(
    async (conversationId) => {
      const detail = await api.get<ConversationDetail>(`/api/conversations/${conversationId}`);
      openConversation(detail.conversation);
    },
    [openConversation],
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

  const setAudioMode = useCallback(
    (id: string, on: boolean) => update((s) => ({ ...s, windows: s.windows.map((w) => (w.id === id ? { ...w, audioMode: on } : w)) })),
    [update],
  );

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
          conversationId: meta.conversationId !== undefined ? meta.conversationId : win.conversationId,
        };
        if (
          next.title === win.title &&
          next.agentName === win.agentName &&
          next.colorSlot === win.colorSlot &&
          next.conversationId === win.conversationId
        )
          return s;
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
  const bumpSessions = useCallback(() => {
    setSessionsVersion((v) => v + 1);
    setListVersion((v) => v + 1);
  }, []);

  // Janelas salvas por conversa (versão anterior): viram a janela do agente (a ativa do próprio
  // usuário) ou uma janela de leitura; a sessão que não existe mais sai.
  const legacyIds = safe.windows
    .filter((w) => w.legacy)
    .map((w) => w.id)
    .join(',');
  useEffect(() => {
    if (!legacyIds) return;
    let alive = true;
    for (const id of legacyIds.split(',')) {
      api
        .get<ConversationDetail>(`/api/conversations/${id}`)
        .then(({ conversation: c }) => {
          if (!alive) return;
          update((s) => {
            const win = s.windows.find((w) => w.id === id && w.legacy);
            if (!win) return s;
            const toAgent = c.userId === me && !c.archivedAt;
            const target = toAgent ? c.agentId : c.id;
            const others = s.windows.filter((w) => w.id !== id);
            const merged = others.some((w) => w.id === target)
              ? others
              : [
                  ...others,
                  {
                    ...win,
                    id: target,
                    kind: toAgent ? ('agent' as const) : ('session' as const),
                    agentId: c.agentId,
                    conversationId: c.id,
                    title: c.title,
                    agentName: c.agentName,
                    colorSlot: c.agentColorSlot,
                    legacy: undefined,
                  },
                ];
            return { ...s, docked: s.docked === id ? target : s.docked, windows: merged };
          });
        })
        .catch((error: unknown) => {
          if (!alive) return;
          // Sem acesso ou excluída: a janela some; outro erro (rede) tenta de novo no próximo carregamento.
          if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
            update((s) => ({
              ...s,
              docked: s.docked === id ? null : s.docked,
              windows: s.windows.filter((w) => w.id !== id),
            }));
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [legacyIds, update, me]);

  // Janela redimensionada: as janelas voltam para dentro da tela.
  useEffect(() => {
    const onResize = () => update((s) => ({ ...s, windows: s.windows.map(clampGeometry) }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [update]);

  const value = useMemo<AgentsApi>(
    () => ({
      state: safe,
      openAgent,
      openConversation,
      openById,
      close,
      minimize,
      restore,
      focus,
      setGeometry,
      dockRight,
      undock,
      setPanelWidth,
      setPanelCollapsed,
      setAudioMode,
      updateMeta,
      registerScreen,
      screenContext,
      listVersion,
      bumpList,
      sessionsVersion,
      bumpSessions,
    }),
    [
      safe,
      openAgent,
      openConversation,
      openById,
      close,
      minimize,
      restore,
      focus,
      setGeometry,
      dockRight,
      undock,
      setPanelWidth,
      setPanelCollapsed,
      setAudioMode,
      updateMeta,
      registerScreen,
      screenContext,
      listVersion,
      bumpList,
      sessionsVersion,
      bumpSessions,
    ],
  );

  // Link do sino ("agente concluiu"): ?conversation=<id> abre a sessão (a ativa na janela do agente).
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('conversation');
    if (!id || !UUID.test(id)) return;
    void openById(id).catch(() => undefined);
    params.delete('conversation');
    const qs = params.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [location.search, location.pathname, openById, navigate]);

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
