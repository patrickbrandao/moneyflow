import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from '../config/brand';

export type Theme = 'light' | 'dark';

/*
 * O tema com UM estado para a página inteira. O botão da topbar, o menu da
 * conta, a paleta e o canvas (`colorMode` do React Flow) leem o mesmo valor:
 * com um `useState` por componente, quem não fez a troca ficaria com o rótulo
 * invertido e gastaria o primeiro clique reescrevendo o tema que já está na tela.
 *
 * O valor inicial é escrito no <html> pelo script inline do index.html, antes
 * da primeira pintura; aqui só o lemos de volta.
 */

const listeners = new Set<() => void>();
let current: Theme | null = null;

const read = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
const get = (): Theme => (current ??= read());

function apply(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // O script do index.html escreve `color-scheme` inline, e inline vence o
  // CSS: sem repetir aqui, a barra de rolagem ficaria no tema do boot.
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage bloqueado: vale só nesta sessão
  }
}

export function setTheme(theme: Theme) {
  current = theme;
  apply(theme);
  for (const listener of listeners) listener();
}

export function toggleTheme() {
  setTheme(get() === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): [Theme, () => void] {
  return [useSyncExternalStore(subscribe, get), toggleTheme];
}
