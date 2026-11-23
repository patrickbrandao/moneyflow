import { describe, expect, it } from 'vitest';
import { createViewCache } from '../src/view-cache';

/*
 * Cache das visões do canvas (tarefa 176): arrastar um nó cria objeto novo
 * só para ele; seleção e esmaecido trocam só os nós afetados.
 */

type Item = { id: string; x: number };
type View = { id: string; x: number; dim: boolean };

describe('createViewCache', () => {
  it('reaproveita a visão de quem não mudou e refaz só a do item novo', () => {
    const cache = createViewCache<Item, View>();
    let derived = 0;
    const derive = (dim: boolean) => (item: Item) => {
      derived += 1;
      return { ...item, dim };
    };
    const a = { id: 'a', x: 0 };
    const b = { id: 'b', x: 0 };
    const c = { id: 'c', x: 0 };
    const first = cache([a, b, c], () => 'off', derive(false));
    expect(derived).toBe(3);

    // Arrasto: o React Flow troca só o objeto do nó arrastado.
    const b2 = { ...b, x: 24 };
    const second = cache([a, b2, c], () => 'off', derive(false));
    expect(derived).toBe(4);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toMatchObject({ id: 'b', x: 24 });

    // Esmaecer só o c: a chave dele muda, o resto continua igual.
    const third = cache([a, b2, c], (item) => (item.id === 'c' ? 'dim' : 'off'), derive(true));
    expect(derived).toBe(5);
    expect(third[0]).toBe(second[0]);
    expect(third[1]).toBe(second[1]);
    expect(third[2]).toMatchObject({ id: 'c', dim: true });
  });

  it('esquece quem saiu da lista e refaz quem voltou', () => {
    const cache = createViewCache<Item, View>();
    const a = { id: 'a', x: 0 };
    const b = { id: 'b', x: 0 };
    const first = cache(
      [a, b],
      () => 'k',
      (item) => ({ ...item, dim: false }),
    );
    cache(
      [a],
      () => 'k',
      (item) => ({ ...item, dim: false }),
    );
    const back = cache(
      [a, b],
      () => 'k',
      (item) => ({ ...item, dim: false }),
    );
    expect(back[0]).toBe(first[0]);
    expect(back[1]).not.toBe(first[1]);
    expect(back[1]).toEqual(first[1]);
  });
});
