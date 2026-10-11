import { t } from '@moneyflow/shared';
import { ArrowLeftRight, Building2, LayoutGrid, Tags, UserRound, Users, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';

/*
 * A navegação inteira do console, como dado. A sidebar, a trilha da topbar e
 * o grupo "Ir para" da paleta (⌘K) saem daqui — adicionar uma tela é
 * adicionar uma linha e a rota em App.tsx.
 *
 * Seções são separadas por um fio (`.nav-sep`). Ícones: lucide-react, sem
 * tamanho (o CSS dá 16px).
 */

export type NavLink = {
  kind: 'link';
  to: string;
  label: string;
  icon: ReactNode;
  /** Só acende na rota exata (útil para "/"). */
  end?: boolean;
  /** Atalho exibido na paleta, no formato "g v". */
  shortcut?: string;
  /** Papéis que enxergam o item; ausente = todos. */
  roles?: string[];
};

export type NavGroup = {
  kind: 'group';
  id: string;
  label: string;
  icon: ReactNode;
  children: NavLink[];
  roles?: string[];
};

export type NavExternal = {
  kind: 'external';
  href: string;
  label: string;
  icon: ReactNode;
};

export type NavEntry = NavLink | NavGroup | NavExternal;

export const NAVIGATION: NavEntry[][] = [
  [
    { kind: 'link', to: '/', label: t.nav.overview, icon: <LayoutGrid />, end: true, shortcut: 'g v' },
    { kind: 'link', to: '/caixas', label: t.nav.caixas, icon: <Wallet />, shortcut: 'g c' },
    { kind: 'link', to: '/entities', label: t.nav.entities, icon: <Building2 />, shortcut: 'g e' },
    { kind: 'link', to: '/transfers', label: t.nav.transfers, icon: <ArrowLeftRight />, shortcut: 'g t' },
  ],
  [
    { kind: 'link', to: '/categories', label: t.nav.categories, icon: <Tags /> },
    { kind: 'link', to: '/users', label: t.nav.users, icon: <Users />, roles: ['admin'], shortcut: 'g u' },
    { kind: 'link', to: '/account', label: t.nav.account, icon: <UserRound /> },
  ],
];

const visible = (roles: string[] | undefined, role: string) => !roles || roles.includes(role);

/** A navegação que o papel enxerga (seções vazias somem). */
export function navigationFor(role: string): NavEntry[][] {
  return NAVIGATION.map((section) =>
    section
      .filter((entry) => entry.kind === 'external' || visible(entry.roles, role))
      .map((entry) =>
        entry.kind === 'group' ? { ...entry, children: entry.children.filter((child) => visible(child.roles, role)) } : entry,
      ),
  ).filter((section) => section.length > 0);
}

/** Todos os links internos, achatados (para a paleta e a trilha). */
export function flatLinks(sections: NavEntry[][]): { link: NavLink; group?: NavGroup }[] {
  const out: { link: NavLink; group?: NavGroup }[] = [];
  for (const section of sections) {
    for (const entry of section) {
      if (entry.kind === 'link') out.push({ link: entry });
      if (entry.kind === 'group') for (const child of entry.children) out.push({ link: child, group: entry });
    }
  }
  return out;
}

/** O link que "possui" a URL: o de prefixo mais longo. */
export function matchLink(pathname: string, sections: NavEntry[][]) {
  let best: { link: NavLink; group?: NavGroup } | null = null;
  for (const item of flatLinks(sections)) {
    const to = item.link.to;
    const hit = to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
    if (hit && (!best || to.length > best.link.to.length)) best = item;
  }
  return best;
}

/** Acordes "g x" da navegação: tecla x → rota. */
export function chordShortcuts(sections: NavEntry[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { link } of flatLinks(sections)) {
    const [first, second] = (link.shortcut ?? '').split(' ');
    if (first === 'g' && second) map.set(second.toLowerCase(), link.to);
  }
  return map;
}
