import type { Edge, Node } from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { Tone } from '../ui';

/*
 * O vocabulário do palco, sem negócio:
 *
 *   ENTRY ──(fluxo vivo)──▶ HUB ══(porta)══▶ ITEM / CLUSTER
 *
 * - ENTRY: a origem (tráfego, clientes, gatilho). Um círculo; a aresta dela é a
 *   única animada, com contador.
 * - HUB: o nó central, com uma porta de saída por tipo de ligação (PORTS).
 * - ITEM: uma folha. Recebe um handle de entrada por porta.
 * - CLUSTER: uma folha que representa um conjunto (contador em destaque).
 *   O tipo NÃO se chama `group`: esse nome é um tipo nativo do React Flow.
 *
 * Ligar = arrastar da porta do hub até o handle da MESMA porta na folha.
 * Para renomear as portas ou criar outras, edite só PORTS (e, se quiser uma
 * cor nova, um --port-N em tokens.css nos dois temas).
 */

export type PortId = string;
export type PortDef = { id: PortId; label: string; color: string };

export const PORTS: PortDef[] = [
  { id: 'data', label: 'Dados', color: 'var(--port-1)' },
  { id: 'events', label: 'Eventos', color: 'var(--port-2)' },
  { id: 'control', label: 'Controle', color: 'var(--port-3)' },
];

export const portDef = (id: PortId) => PORTS.find((port) => port.id === id);

/** Põe a cor da porta em `--port`, que o canvas.css usa em pontos, handles e legenda. */
export const portStyle = (id: PortId, extra?: CSSProperties): CSSProperties =>
  ({ '--port': portDef(id)?.color ?? 'var(--text-faint)', ...extra }) as CSSProperties;

export const outHandle = (port: PortId) => `out:${port}`;
export const inHandle = (port: PortId) => `in:${port}`;
export const portOfHandle = (handle: string | null | undefined, side: 'out' | 'in'): PortId | null =>
  handle?.startsWith(`${side}:`) ? handle.slice(side.length + 1) : null;

export type BadgeSpec = { label: string; tone: Tone };

export type HubData = {
  title: string;
  subtitle: string;
  description?: string;
  badges: BadgeSpec[];
  isActive: boolean;
  /** Derivado das arestas na hora de desenhar. */
  counts?: Record<PortId, number>;
};

export type ItemData = {
  title: string;
  subtitle: string;
  description?: string;
  /** Emoji ou URL de imagem; sem nada, monograma. */
  icon?: string | null;
  isActive: boolean;
  /** Pares chave/valor livres, mostrados na gaveta. */
  meta?: Record<string, string>;
  /** Derivado das arestas na hora de desenhar. */
  ports?: PortId[];
  /** Há uma gravação em andamento para este nó. */
  busy?: boolean;
};

export type GroupData = ItemData & {
  count: number;
  /** [singular, plural] do rótulo sob o número. */
  countLabel: [string, string];
};

export type EntryData = {
  label: string;
  description?: string;
  /** Conexões ativas agora: acende o nó e anima a aresta. */
  live: number;
};

export type HubNode = Node<HubData, 'hub'>;
export type ItemNode = Node<ItemData, 'item'>;
export type GroupNode = Node<GroupData, 'cluster'>;
export type EntryNode = Node<EntryData, 'entry'>;
export type CanvasNode = HubNode | ItemNode | GroupNode | EntryNode;
export type LeafNode = ItemNode | GroupNode;

export type PortEdgeData = { port: PortId; saving?: boolean };
export type FlowEdgeData = { live: number };
export type PortEdge = Edge<PortEdgeData, 'port'>;
export type FlowEdge = Edge<FlowEdgeData, 'flow'>;
export type CanvasEdge = PortEdge | FlowEdge;

export type Graph = { nodes: CanvasNode[]; edges: CanvasEdge[] };

export const HUB_ID = 'hub';
export const ENTRY_ID = 'entry';

export const isLeaf = (node: CanvasNode | undefined): node is LeafNode => node?.type === 'item' || node?.type === 'cluster';

export const portEdgeId = (port: PortId, target: string) => `edge:${port}:${target}`;

export const makePortEdge = (port: PortId, target: string, saving = false): PortEdge => ({
  id: portEdgeId(port, target),
  type: 'port',
  source: HUB_ID,
  sourceHandle: outHandle(port),
  target,
  targetHandle: inHandle(port),
  data: { port, saving },
  zIndex: 1,
});

export const makeFlowEdge = (): FlowEdge => ({
  id: 'flow',
  type: 'flow',
  source: ENTRY_ID,
  sourceHandle: 'out',
  target: HUB_ID,
  targetHandle: 'in',
  data: { live: 0 },
  selectable: false,
  deletable: false,
  zIndex: 1,
});
