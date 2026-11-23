/*
 * Cache de visões derivadas por item (tarefa 176): a cada chamada, devolve o
 * mesmo objeto derivado do item enquanto o item (a mesma identidade) e a
 * chave do que muda a visão (seleção, esmaecido, alças) forem os mesmos. Num
 * arrasto do canvas, só o nó arrastado ganha objeto novo, e o `memo` dos
 * outros segura o render.
 */
export type ViewCache<T, V> = (items: readonly T[], key: (item: T) => string, derive: (item: T) => V) => V[];

export function createViewCache<T extends { id: string }, V>(): ViewCache<T, V> {
  let previous = new Map<string, { source: T; key: string; view: V }>();
  return (items, key, derive) => {
    const next = new Map<string, { source: T; key: string; view: V }>();
    const views = items.map((item) => {
      const k = key(item);
      const hit = previous.get(item.id);
      const view = hit && hit.source === item && hit.key === k ? hit.view : derive(item);
      next.set(item.id, { source: item, key: k, view });
      return view;
    });
    // Só os itens desta chamada ficam: o que saiu do grafo não segura memória.
    previous = next;
    return views;
  };
}
