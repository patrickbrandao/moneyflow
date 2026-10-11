import { ChevronRight, Moon, PanelLeftOpen, Search, Sun } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { chordShortcuts, matchLink, navigationFor } from '../../config/navigation';
import { useUser } from '../../lib/auth';
import { armChord, isChordKey, isTypingTarget, usePalette } from '../../lib/commands';
import { useStored } from '../../lib/storage';
import { useTheme } from '../../lib/theme';
import { Kbd } from '../ui';
import { CommandPalette } from './CommandPalette';
import { Notifications } from './Notifications';
import { NARROW, Sidebar } from './Sidebar';

export type Crumb = { label: string; to?: string };

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
  const { open: openPalette } = usePalette();
  const [theme, toggleTheme] = useTheme();

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
      <div className={`shell${collapsed ? ' sidebar-collapsed' : ''}`}>
        <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} onCollapse={() => setCollapsed(true)} />
        {menuOpen && <div className="overlay" style={{ zIndex: 45 }} onClick={() => setMenuOpen(false)} />}

        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => (window.matchMedia(NARROW).matches ? setMenuOpen(true) : setCollapsed(false))}
            title="Exibir o menu"
            aria-label="Exibir o menu"
          >
            <PanelLeftOpen />
          </button>
          <nav className="crumbs" aria-label="Trilha">
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
          <button type="button" className="icon-btn" onClick={() => openPalette()} title="Buscar (⌘K)" aria-label="Buscar">
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
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
            aria-label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
          <Notifications />
        </header>

        <main className="main">
          <div className={`main-panel${stage ? ' stage' : ''}`}>{children ?? <Outlet />}</div>
        </main>
      </div>
      <CommandPalette />
    </CrumbContext.Provider>
  );
}
