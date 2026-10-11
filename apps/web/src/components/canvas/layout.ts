import type { XYPosition } from '@xyflow/react';
import { type CanvasNode, ENTRY_ID, HUB_ID, isLeaf } from './types';

/**
 * Geometria do palco, em múltiplos de 24 (a grade do `snapGrid` e do fundo
 * pontilhado): o hub na origem, a entrada à esquerda e as folhas numa coluna
 * à direita.
 */
export const GRID = 24;
export const HUB_WIDTH = 288;
export const LEAF_COLUMN_X = HUB_WIDTH + 120;
export const LEAF_STEP_Y = 96;
export const DEFAULT_HUB: XYPosition = { x: 0, y: 0 };
export const DEFAULT_ENTRY: XYPosition = { x: -336, y: 48 };

export const snap = (value: number) => Math.round(value / GRID) * GRID;

const collides = (a: XYPosition, b: XYPosition) => Math.abs(a.x - b.x) < 240 && Math.abs(a.y - b.y) < LEAF_STEP_Y - 8;

/** O primeiro vão livre da coluna de folhas. */
export function freeSlot(hub: XYPosition, taken: XYPosition[]): XYPosition {
  for (let slot = 0; slot < 500; slot += 1) {
    const candidate = { x: hub.x + LEAF_COLUMN_X, y: hub.y + slot * LEAF_STEP_Y };
    if (!taken.some((point) => collides(point, candidate))) return candidate;
  }
  return { x: hub.x + LEAF_COLUMN_X, y: hub.y };
}

/** Recalcula tudo: hub na origem, entrada à esquerda, grupos e depois itens em coluna, por nome. */
export function autoLayout(nodes: CanvasNode[]): CanvasNode[] {
  const leaves = nodes
    .filter(isLeaf)
    .sort((a, b) => (a.type === b.type ? a.data.title.localeCompare(b.data.title) : a.type === 'cluster' ? -1 : 1));
  const order = new Map(leaves.map((node, index) => [node.id, index]));
  return nodes.map((node) => {
    if (node.id === HUB_ID) return { ...node, position: DEFAULT_HUB };
    if (node.id === ENTRY_ID) return { ...node, position: DEFAULT_ENTRY };
    const index = order.get(node.id);
    return index === undefined ? node : { ...node, position: { x: LEAF_COLUMN_X, y: index * LEAF_STEP_Y } };
  });
}
