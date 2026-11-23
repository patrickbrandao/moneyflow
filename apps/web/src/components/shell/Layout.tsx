import { t } from '@moneyflow/shared';
import { ChevronRight, Moon, PanelLeftOpen, Search, Sun } from 'lucide-react';

import { type CSSProperties, createContext, type ReactNode, Suspense, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AgentSidePanel, usePanelColumn } from '../../agents/AgentSidePanel';
import { AgentsMenu } from '../../agents/AgentsMenu';
import { AgentWindowsLayer } from '../../agents/AgentWindows';
import { chordShortcuts, matchLink, navigationFor } from '../../config/navigation';
import { useUser } from '../../lib/auth';
import { armChord, isChordKey, isTypingTarget, usePalette } from '../../lib/commands';
import { lazyNamed } from '../../lib/lazy';
import { useStored } from '../../lib/storage';
import { useTheme } from '../../lib/theme';
import { ReminderAlarm } from '../notes/ReminderAlarm';
import { Kbd } from '../ui';
import { Notifications } from './Notifications';
import { ErrorBoundary, PageSlot } from './PageSlot';
import { NARROW, Sidebar } from './Sidebar';

export type Crumb = { label: string; to?: string };

/*
 * A paleta (⌘K, cmdk + o diálogo do Radix) é um pedaço próprio (tarefa 128):
 * baixada quando o navegador fica ocioso depois da carga, montada na primeira
 * abertura e mantida depois.
 */
const loadPalette = () => import('./CommandPalette');
const CommandPalette = lazyNamed(loadPalette, 'CommandPalette');

/*
 * A trilha da topbar sai da navegação (grupo › item) e, além disso, de quem a
 * página disser: `useCrumbs([{ label: 'Pedidos' }])` acrescenta o nível de
 * detalhe (o nome do registro aberto, por exemplo).
 */
const CrumbContext = createContext<(crumbs: Crumb[]) => void>(() => {});

export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(CrumbContext);
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    set(crumbs);
    return () => set([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, set]);
}

/**
 * O shell: sidebar | (topbar / palco). `stage` = a página é um palco (canvas):
 * o painel central não rola nem tem padding, e a página ocupa tudo.
 */
export function Layout({ stage, children }: { stage?: boolean; children?: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useUser();
  const [menuOpen, setMenuOpen] = useState(false);
  // Recolher é preferência de quem usa, por navegador; na tela estreita não se aplica.
  const [collapsed, setCollapsed] = useStored('sidebar-collapsed', false);
  const [extra, setExtra] = useState<Crumb[]>([]);
  const { open: openPalette, isOpen: paletteOpen } = usePalette();
  const [paletteUsed, setPaletteUsed] = useState(false);
  if (paletteOpen && !paletteUsed) setPaletteUsed(true);
  useEffect(() => {
    const prefetch = () => void loadPalette().catch(() => undefined);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(id);
  }, []);
  const [theme, toggleTheme] = useTheme();
  // Agente ancorado à direita: uma terceira coluna do grid (o palco encolhe).
  const panelColumn = usePanelColumn();

  const sections = useMemo(() => navigationFor(user.role), [user.role]);
  const hit = matchLink(location.pathname, sections);
  const crumbs: Crumb[] = [
    ...(hit?.group ? [{ label: hit.group.label }] : []),
    ...(hit ? [{ label: hit.link.label, to: hit.link.to }] : []),
    ...extra,
  ];

  // Acordes "g + tecla" da navegação (o `shortcut` de cada link).
  useEffect(() => {
    const shortcuts = chordShortcuts(sections);
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'g' && !isChordKey(event)) {
        armChord();
        return;
      }
      if (!isChordKey(event)) return;
      const to = shortcuts.get(event.key.toLowerCase());
      if (to) {
        event.preventDefault();
        navigate(to);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [sections, navigate]);

  return (
    <CrumbContext.Provider value={setExtra}>
      <div
        className={`shell${collapsed ? ' sidebar-collapsed' : ''}${panelColumn ? ' has-agent-panel' : ''}`}
        style={panelColumn ? ({ '--agent-panel-w': panelColumn } as CSSProperties) : undefined}
      >
        <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} onCollapse={() => setCollapsed(true)} />
        {menuOpen && (
          // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: fundo do menu no celular; o botão de recolher fecha pelo teclado.
          <div className="overlay" style={{ zIndex: 45 }} onClick={() => setMenuOpen(false)} />
        )}

        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => (window.matchMedia(NARROW).matches ? setMenuOpen(true) : setCollapsed(false))}
            title={t.shell.showMenu}
            aria-label={t.shell.showMenu}
          >
            <PanelLeftOpen />
          </button>
          <nav className="crumbs" aria-label={t.shell.breadcrumbs}>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="contents">
                {index > 0 && <ChevronRight />}
                {crumb.to && index < crumbs.length - 1 ? (
                  <Link to={crumb.to}>{crumb.label}</Link>
                ) : (
                  <span className="cur">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
          <button
            type="button"
            className="icon-btn"
            onClick={() => openPalette()}
            title={t.shell.searchShortcut}
            aria-label={t.shell.search}
          >
            <Search />
          </button>
          <span className="hidden items-center gap-1 pr-1 md:inline-flex" aria-hidden>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? t.shell.themeLight : t.shell.themeDark}
            aria-label={theme === 'dark' ? t.shell.themeLight : t.shell.themeDark}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
          {/* Alarme dos lembretes (spec 035): entre o tema e os agentes. */}
          <ReminderAlarm />
          <AgentsMenu />
          <Notifications />
        </header>

        <main className="main">
          <div className={`main-panel${stage ? ' stage' : ''}`}>
            <PageSlot resetKey={location.pathname}>{children ?? <Outlet />}</PageSlot>
          </div>
        </main>
        <AgentSidePanel />
      </div>
      <AgentWindowsLayer />
      {paletteUsed && (
        <ErrorBoundary resetKey="" fallback={null}>
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        </ErrorBoundary>
      )}
    </CrumbContext.Provider>
  );
}
