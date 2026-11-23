import { type ComponentType, lazy } from 'react';

/** Quando foi a última recarga por um pedaço que não carregou (por aba). */
const RELOAD_KEY = 'moneyflow:chunk-reload';
const RELOAD_WINDOW_MS = 30_000;

/**
 * Componente carregado sob demanda (tarefa 128), pelo nome do export: as telas
 * (`App.tsx`) e o miolo da conversa dos agentes (`ConversationPane.tsx`).
 *
 * Se o pedaço não carrega, o mais provável é uma versão nova no ar: os
 * arquivos antigos sumiram e o servidor devolve o index.html no lugar. A aba
 * recarrega uma vez para buscar o index.html novo (servido com `no-cache`);
 * se falhar de novo logo em seguida, o erro sobe para o aviso da tela
 * (o `ErrorBoundary` de `PageSlot.tsx`), sem laço de recargas.
 */
// biome-ignore lint/suspicious/noExplicitAny: o mesmo limite do `lazy` do React (ComponentType<any>), que guarda as props do componente.
export function lazyNamed<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K) {
  return lazy(async () => {
    try {
      const module = await load();
      return { default: module[name] };
    } catch (error) {
      if (reloadOnce()) return new Promise<never>(() => {});
      throw error;
    }
  });
}

function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Sem sessionStorage não há como saber se já recarregou: mostra o erro.
    return false;
  }
  window.location.reload();
  return true;
}
