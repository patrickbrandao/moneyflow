import type { CanvasNodeKind, CanvasPosition, FlowEdgeDto, FlowEdgeKind, FlowGraphData, FlowNodeDto } from '@moneyflow/shared';
import type { Edge, Node, XYPosition } from '@xyflow/react';

/*
 * Adaptador do canvas de fluxo (spec 014): o que a API devolve
 * (flow_graph_nodes/edges + posições salvas) vira nós e arestas do React
 * Flow, sem negócio nos componentes:
 *
 *   entidades que pagam ──▶ CAIXAS ──fatura──▶ CARTÕES ──▶ entidades que recebem
 *
 * - caixas são hubs (saldo / limite usado), no centro;
 * - entidades são folhas: à esquerda as que mais mandam dinheiro, à direita as
 *   que mais recebem; com muitas, as do mesmo grupo de categoria viram um
 *   cluster (expansível);
 * - aresta = soma do período por origem, destino e tipo; espessura pela raiz
 *   do valor; cor pelo tipo (--port-N); previsto tracejado.
 */

export type FlowMode = 'realized' | 'forecast' | 'both';

export const EDGE_KINDS: FlowEdgeKind[] = ['receipt', 'payment', 'transfer', 'card_invoice', 'card_purchase'];

/** Cor de cada tipo de aresta: só tokens (--port-N existe nos dois temas). */
export const EDGE_COLOR: Record<FlowEdgeKind, string> = {
  receipt: 'var(--port-4)',
  payment: 'var(--port-5)',
  transfer: 'var(--port-2)',
  card_invoice: 'var(--port-3)',
  card_purchase: 'var(--port-7)',
};

/** Acima de quantas entidades o canvas agrupa as folhas por grupo de categoria. */
export const GROUP_THRESHOLD = 12;
/** Um grupo só vira cluster com pelo menos tantas entidades. */
const GROUP_MIN = 3;
/** node_id do cluster "sem categoria" (canvas_node_positions exige uuid). */
export const NO_GROUP_ID = '00000000-0000-0000-0000-000000000000';

export const GRID = 24;
const CAIXA_STEP = 168;
const LEAF_STEP = 72;
const COLUMN = 456;

export const snap = (value: number) => Math.round(value / GRID) * GRID;

export type CaixaNodeData = {
  ref: FlowNodeDto;
  name: string;
  isCard: boolean;
  inCents: number;
  outCents: number;
  dim: boolean;
};
export type EntityNodeData = {
  ref: FlowNodeDto;
  name: string;
  side: 'left' | 'right';
  inCents: number;
  outCents: number;
  colorSlot: number | null;
  groupName: string | null;
  dim: boolean;
};
export type ClusterNodeData = {
  groupId: string;
  name: string;
  side: 'left' | 'right';
  entityIds: string[];
  entityNames: string[];
  inCents: number;
  outCents: number;
  colorSlot: number | null;
  dim: boolean;
  /** Membros que casam com o filtro de entidades (destaque, spec 014). */
  matchedNames?: string[];
};

export type CaixaFlowNode = Node<CaixaNodeData, 'caixa'>;
export type EntityFlowNode = Node<EntityNodeData, 'entity'>;
export type ClusterFlowNode = Node<ClusterNodeData, 'cluster'>;
export type FlowNode = CaixaFlowNode | EntityFlowNode | ClusterFlowNode;

/** Uma ponta de aresta como a API entende (para pedir as linhas da gaveta). */
export type EndRef = { kind: 'caixa' | 'entity'; id: string } | { kind: 'cluster'; entityIds: string[] };

export type MoneyEdgeData = {
  kind: FlowEdgeKind;
  realizedCents: number;
  forecastCents: number;
  width: number;
  mode: FlowMode;
  source: EndRef;
  target: EndRef;
  lines: number;
  dim: boolean;
};
export type MoneyEdge = Edge<MoneyEdgeData, 'money'>;

export const nodeKey = (kind: 'caixa' | 'entity', id: string) => `${kind}:${id}`;
export const groupKey = (groupId: string) => `group:${groupId}`;

/** Id do nó do React Flow → linha de canvas_node_positions. */
export function positionRef(nodeId: string): { nodeKind: CanvasNodeKind; nodeId: string } | null {
  const parts = nodeId.split(':');
  // O cluster do lado esquerdo ("group:<id>:left") não é salvo: a chave do banco é só o grupo.
  if (parts.length !== 2) return null;
  const [kind, id] = parts as [string, string];
  if (kind === 'caixa' || kind === 'entity') return { nodeKind: kind, nodeId: id };
  if (kind === 'group') return { nodeKind: 'category_group', nodeId: id };
  return null;
}

const savedKey = (p: CanvasPosition) => (p.nodeKind === 'category_group' ? groupKey(p.nodeId) : nodeKey(p.nodeKind, p.nodeId));

export const edgeValue = (edge: Pick<FlowEdgeDto, 'realizedCents' | 'forecastCents'>, mode: FlowMode) =>
  mode === 'realized' ? edge.realizedCents : mode === 'forecast' ? edge.forecastCents : edge.realizedCents + edge.forecastCents;

export type BuiltGraph = { nodes: FlowNode[]; edges: MoneyEdge[]; entityCount: number; grouped: boolean };

export function buildGraph(
  data: FlowGraphData,
  opts: { mode: FlowMode; expanded: Set<string>; hiddenKinds?: Set<FlowEdgeKind> },
): BuiltGraph {
  const { mode, expanded } = opts;
  const byId = new Map(data.nodes.map((n) => [nodeKey(n.kind, n.id), n]));
  const edges = data.edges.filter((e) => edgeValue(e, mode) !== 0 && !opts.hiddenKinds?.has(e.edgeKind));

  // Totais de entrada/saída por nó, no modo escolhido.
  const totals = new Map<string, { in: number; out: number }>();
  const bump = (key: string, field: 'in' | 'out', value: number) => {
    const current = totals.get(key) ?? { in: 0, out: 0 };
    current[field] += value;
    totals.set(key, current);
  };
  for (const e of edges) {
    const value = edgeValue(e, mode);
    bump(nodeKey(e.sourceKind, e.sourceId), 'out', value);
    bump(nodeKey(e.targetKind, e.targetId), 'in', value);
  }

  const entityKeys = [...new Set(edges.flatMap((e) => [nodeKey(e.sourceKind, e.sourceId), nodeKey(e.targetKind, e.targetId)]))].filter(
    (key) => key.startsWith('entity:') && byId.has(key),
  );
  const side = (key: string): 'left' | 'right' => {
    const total = totals.get(key) ?? { in: 0, out: 0 };
    return total.out > total.in ? 'left' : 'right';
  };

  // Agrupamento por grupo de categoria (e lado), quando há muitas entidades.
  const grouped = entityKeys.length > GROUP_THRESHOLD;
  const memberOf = new Map<string, string>();
  const clusters = new Map<string, { groupId: string; side: 'left' | 'right'; keys: string[]; name: string; colorSlot: number | null }>();
  if (grouped) {
    const buckets = new Map<string, string[]>();
    for (const key of entityKeys) {
      const node = byId.get(key)!;
      const bucket = `${node.mainGroupCategoryId ?? NO_GROUP_ID}|${side(key)}`;
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
    }
    for (const [bucket, keys] of buckets) {
      const [groupId, s] = bucket.split('|') as [string, 'left' | 'right'];
      if (keys.length < GROUP_MIN || expanded.has(groupId)) continue;
      // Um grupo pode aparecer dos dois lados: o id do nó leva o lado, a posição salva usa o do lado direito.
      const id = s === 'right' ? groupKey(groupId) : `${groupKey(groupId)}:left`;
      const sample = byId.get(keys[0]!)!;
      clusters.set(id, { groupId, side: s, keys, name: sample.mainGroupName ?? '', colorSlot: sample.mainGroupColorSlot });
      for (const key of keys) memberOf.set(key, id);
    }
  }
  const displayKey = (key: string) => memberOf.get(key) ?? key;

  // Arestas agregadas por nó exibido e tipo.
  const agg = new Map<string, MoneyEdgeData & { from: string; to: string }>();
  const endRef = (kind: 'caixa' | 'entity', id: string, display: string): EndRef => {
    const cluster = clusters.get(display);
    return cluster ? { kind: 'cluster', entityIds: cluster.keys.map((k) => k.slice('entity:'.length)) } : { kind, id };
  };
  for (const e of edges) {
    const from = displayKey(nodeKey(e.sourceKind, e.sourceId));
    const to = displayKey(nodeKey(e.targetKind, e.targetId));
    const key = `${from}|${to}|${e.edgeKind}`;
    const current = agg.get(key);
    if (current) {
      current.realizedCents += e.realizedCents;
      current.forecastCents += e.forecastCents;
      current.lines += e.lines;
    } else {
      agg.set(key, {
        from,
        to,
        kind: e.edgeKind,
        realizedCents: e.realizedCents,
        forecastCents: e.forecastCents,
        lines: e.lines,
        width: 0,
        mode,
        source: endRef(e.sourceKind, e.sourceId, from),
        target: endRef(e.targetKind, e.targetId, to),
        dim: false,
      });
    }
  }
  const max = Math.max(1, ...[...agg.values()].map((e) => Math.abs(edgeValue(e, mode))));
  const flowEdges: MoneyEdge[] = [...agg.entries()].map(([id, e]) => {
    const { from, to, ...data } = e;
    return {
      id,
      type: 'money',
      source: from,
      target: to,
      sourceHandle: 'out',
      targetHandle: 'in',
      data: { ...data, width: 1.5 + 7 * Math.sqrt(Math.abs(edgeValue(e, mode)) / max) },
      zIndex: 1,
    };
  });

  // Nós.
  const saved = new Map(data.positions.map((p) => [savedKey(p), { x: p.x, y: p.y }]));
  const hasCards = data.nodes.some((n) => n.kind === 'caixa' && n.caixaKind === 'credit_card');
  const columns = { left: -COLUMN, caixa: 0, card: COLUMN, right: hasCards ? 2 * COLUMN : COLUMN };
  const t = (key: string) => totals.get(key) ?? { in: 0, out: 0 };

  const caixaNodes: CaixaFlowNode[] = data.nodes
    .filter((n) => n.kind === 'caixa')
    .map((n) => {
      const key = nodeKey('caixa', n.id);
      return {
        id: key,
        type: 'caixa',
        position: { x: 0, y: 0 },
        data: { ref: n, name: n.name, isCard: n.caixaKind === 'credit_card', inCents: t(key).in, outCents: t(key).out, dim: false },
      };
    });
  const entityNodes: EntityFlowNode[] = entityKeys
    .filter((key) => !memberOf.has(key))
    .map((key) => {
      const n = byId.get(key)!;
      return {
        id: key,
        type: 'entity',
        position: { x: 0, y: 0 },
        data: {
          ref: n,
          name: n.name,
          side: side(key),
          inCents: t(key).in,
          outCents: t(key).out,
          colorSlot: n.mainGroupColorSlot,
          groupName: n.mainGroupName,
          dim: false,
        },
      };
    });
  const clusterNodes: ClusterFlowNode[] = [...clusters.entries()].map(([id, c]) => {
    const inCents = c.keys.reduce((acc, k) => acc + t(k).in, 0);
    const outCents = c.keys.reduce((acc, k) => acc + t(k).out, 0);
    return {
      id,
      type: 'cluster',
      position: { x: 0, y: 0 },
      data: {
        groupId: c.groupId,
        name: c.name,
        side: c.side,
        entityIds: c.keys.map((k) => k.slice('entity:'.length)),
        entityNames: c.keys.map((k) => byId.get(k)!.name).sort((a, b) => a.localeCompare(b)),
        inCents,
        outCents,
        colorSlot: c.colorSlot,
        dim: false,
      },
    };
  });

  const nodes: FlowNode[] = [...caixaNodes, ...clusterNodes, ...entityNodes];
  layout(nodes, columns, saved);
  return { nodes, edges: flowEdges, entityCount: entityKeys.length, grouped };
}

/**
 * Destaque por tags e favoritas (spec 014): ids (nós e arestas exibidos) que
 * ficam em destaque — as entidades que casam, os clusters com algum membro que
 * casa, as arestas que tocam um deles e as caixas dessas arestas. null = sem filtro.
 */
export function highlightIds(
  data: FlowGraphData,
  nodes: FlowNode[],
  edges: MoneyEdge[],
  match: ((node: FlowNodeDto) => boolean) | null,
): Set<string> | null {
  if (!match) return null;
  const byId = new Map(data.nodes.filter((n) => n.kind === 'entity').map((n) => [n.id, n]));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'entity' && match(node.data.ref)) ids.add(node.id);
    if (node.type === 'cluster' && node.data.entityIds.some((id) => byId.has(id) && match(byId.get(id)!))) ids.add(node.id);
  }
  const leaves = new Set(ids);
  for (const edge of edges) {
    if (!leaves.has(edge.source) && !leaves.has(edge.target)) continue;
    ids.add(edge.id);
    ids.add(edge.source);
    ids.add(edge.target);
  }
  return ids;
}

/** Auto-layout em colunas (centradas no zero, grade de 24), com as posições salvas por cima. */
function layout(nodes: FlowNode[], columns: Record<'left' | 'caixa' | 'card' | 'right', number>, saved: Map<string, XYPosition>) {
  const volume = (n: FlowNode) => n.data.inCents + n.data.outCents;
  const groups: Record<keyof typeof columns, FlowNode[]> = { left: [], caixa: [], card: [], right: [] };
  for (const node of nodes) {
    if (node.type === 'caixa') groups[node.data.isCard ? 'card' : 'caixa'].push(node);
    else groups[node.data.side].push(node);
  }
  for (const [column, list] of Object.entries(groups) as [keyof typeof columns, FlowNode[]][]) {
    list.sort((a, b) => (a.type === 'caixa' && b.type === 'caixa' ? a.data.name.localeCompare(b.data.name) : volume(b) - volume(a)));
    const step = column === 'caixa' || column === 'card' ? CAIXA_STEP : LEAF_STEP;
    const top = -((list.length - 1) * step) / 2;
    list.forEach((node, index) => {
      node.position = saved.get(node.id) ?? { x: columns[column], y: snap(top + index * step) };
    });
  }
}
