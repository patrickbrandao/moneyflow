import type { CanvasPosition, FlowGraphData } from '@moneyflow/shared';
import { t } from '@moneyflow/shared';
import { type NodeChange, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import { LayoutTemplate, Maximize, Minus, Plus, Waypoints } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { isChordKey, isTypingTarget, useRegisterCommands } from '../../lib/commands';
import { useTheme } from '../../lib/theme';
import { useToast } from '../Toast';
import { EmptyState, useConfirm } from '../ui';
import { EdgeHoverContext, flowEdgeTypes } from './edges';
import { FlowDrawer, type FlowSelection } from './FlowDrawer';
import { buildGraph, EDGE_COLOR, EDGE_KINDS, type FlowMode, type FlowNode, GRID, type MoneyEdge, positionRef } from './graph';
import { flowNodeTypes } from './nodes';

const FIT = { padding: 0.2, maxZoom: 1 } as const;
/** Debounce da gravação das posições (o mesmo do template). */
const SAVE_DELAY = 400;

type Props = {
  data: FlowGraphData;
  mode: FlowMode;
  /** Reorganizar apaga as posições salvas e pede o grafo de novo. */
  onReset: () => void;
};

/**
 * O palco do fluxo de dinheiro: React Flow com caixas (hubs), entidades e
 * clusters (folhas), arestas de dinheiro, a gaveta à direita, a toolbar de
 * zoom, a legenda dos tipos e os atalhos (f enquadra, Esc fecha a gaveta).
 * Arrastar grava a posição do nó para o usuário (debounce de 400 ms).
 */
export function MoneyFlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ data, mode, onReset }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const [theme] = useTheme();
  const { fitView, zoomIn, zoomOut, getNode, setCenter } = useReactFlow<FlowNode, MoneyEdge>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<{ type: 'node' | 'edge'; id: string } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const built = useMemo(() => buildGraph(data, { mode, expanded }), [data, mode, expanded]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(built.nodes);
  const [edges, setEdges] = useEdgesState<MoneyEdge>(built.edges);

  // Grafo novo (período, caixas, modo, grupos): mantém onde o usuário largou os nós nesta sessão.
  const moved = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    setNodes(built.nodes.map((n) => ({ ...n, position: moved.current.get(n.id) ?? n.position })));
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  useEffect(() => {
    const timer = setTimeout(() => void fitView(FIT), 60);
    return () => clearTimeout(timer);
  }, [fitView, data]);

  // ------------------------------------------------------------ posições --
  const pending = useRef(new Map<string, CanvasPosition>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    const positions = [...pending.current.values()];
    pending.current.clear();
    if (positions.length === 0) return;
    try {
      await api.put('/api/flow/positions', { positions });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [toast]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type === 'select' && change.selected) setSelection({ type: 'node', id: change.id });
        if (change.type === 'position' && change.position) {
          moved.current.set(change.id, change.position);
          if (change.dragging === false || change.dragging === undefined) {
            const ref = positionRef(change.id);
            if (ref) pending.current.set(change.id, { ...ref, x: change.position.x, y: change.position.y });
          }
        }
      }
      if (pending.current.size > 0) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), SAVE_DELAY);
      }
    },
    [onNodesChange, flush],
  );

  // Ao soltar o nó, o React Flow manda a posição final com dragging=false.
  const onNodeDragStop = useCallback(
    (_event: unknown, node: FlowNode) => {
      const ref = positionRef(node.id);
      if (!ref) return;
      moved.current.set(node.id, node.position);
      pending.current.set(node.id, { ...ref, x: node.position.x, y: node.position.y });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY);
    },
    [flush],
  );

  // ------------------------------------------------------------- seleção --
  const selected = useMemo<FlowSelection | null>(() => {
    if (!selection) return null;
    if (selection.type === 'node') {
      const node = nodes.find((n) => n.id === selection.id);
      return node ? { type: 'node', node } : null;
    }
    const edge = edges.find((e) => e.id === selection.id || `${e.id}:forecast` === selection.id);
    if (!edge) return null;
    const name = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? '';
    return { type: 'edge', edge, sourceName: name(edge.source), targetName: name(edge.target) };
  }, [selection, nodes, edges]);

  // Realce: o selecionado e os vizinhos; o resto esmaece.
  const focusIds = useMemo(() => {
    if (!selected) return null;
    if (selected.type === 'edge') return new Set([selected.edge.source, selected.edge.target, selected.edge.id]);
    const ids = new Set([selected.node.id]);
    for (const e of edges) {
      if (e.source === selected.node.id || e.target === selected.node.id) {
        ids.add(e.id);
        ids.add(e.source);
        ids.add(e.target);
      }
    }
    return ids;
  }, [selected, edges]);

  const viewNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: selection?.type === 'node' && selection.id === n.id,
        data: { ...n.data, dim: focusIds !== null && !focusIds.has(n.id) },
      })) as FlowNode[],
    [nodes, focusIds, selection],
  );
  const viewEdges = useMemo(() => {
    const pos = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      // Caixa → caixa na mesma coluna: por baixo/cima, em vez de dar a volta pela lateral.
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      const vertical = a?.type === 'caixa' && b?.type === 'caixa' && Math.abs(a.position.x - b.position.x) < 200;
      const handles = vertical
        ? a.position.y <= b.position.y
          ? { sourceHandle: 'out-b', targetHandle: 'in-t' }
          : { sourceHandle: 'out-t', targetHandle: 'in-b' }
        : { sourceHandle: 'out', targetHandle: 'in' };
      return {
        ...e,
        ...handles,
        selected: selection?.type === 'edge' && (selection.id === e.id || selection.id === `${e.id}:forecast`),
        data: e.data ? { ...e.data, dim: focusIds !== null && !focusIds.has(e.id) } : e.data,
      };
    });
  }, [edges, nodes, focusIds, selection]);

  const focusNode = useCallback(
    (id: string) => {
      const node = getNode(id);
      if (!node) return;
      const w = node.measured?.width ?? 0;
      const h = node.measured?.height ?? 0;
      void setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 300 });
    },
    [getNode, setCenter],
  );

  const expand = useCallback((groupId: string) => {
    setExpanded((current) => new Set([...current, groupId]));
    setSelection(null);
  }, []);

  const relayout = useCallback(async () => {
    const ok = await confirm({ title: t.flow.relayoutConfirm, description: t.flow.relayoutDescription, confirmLabel: t.flow.relayout });
    if (!ok) return;
    pending.current.clear();
    moved.current.clear();
    try {
      await api.del('/api/flow/positions');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
    setExpanded(new Set());
    onReset();
  }, [confirm, onReset, toast]);

  useRegisterCommands(
    [
      { id: 'flow-fit', label: t.flow.fit, group: 'Recurso', icon: <Maximize />, shortcut: 'f', run: () => void fitView(FIT) },
      { id: 'flow-relayout', label: t.flow.relayout, group: 'Recurso', icon: <LayoutTemplate />, run: () => void relayout() },
    ],
    [relayout],
  );

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelection(null);
        return;
      }
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey || isChordKey(event)) return;
      if (event.key === 'f') {
        event.preventDefault();
        void fitView(FIT);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [fitView]);

  const hoverValue = useMemo(() => ({ hovered }), [hovered]);
  const empty = built.edges.length === 0;

  return (
    <EdgeHoverContext.Provider value={hoverValue}>
      <div className="stage-wrap">
        <ReactFlow<FlowNode, MoneyEdge>
          nodes={viewNodes}
          edges={viewEdges}
          nodeTypes={flowNodeTypes}
          edgeTypes={flowEdgeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStop={onNodeDragStop}
          onEdgeClick={(_event, edge) => setSelection({ type: 'edge', id: edge.id })}
          onEdgeMouseEnter={(_event, edge) => setHovered(edge.id)}
          onEdgeMouseLeave={() => setHovered(null)}
          onPaneClick={() => setSelection(null)}
          selectNodesOnDrag={false}
          nodesConnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          snapToGrid
          snapGrid={[GRID, GRID]}
          minZoom={0.2}
          maxZoom={1.6}
          colorMode={theme}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={FIT}
        />

        {empty && (
          <div className="flow-empty">
            <EmptyState icon={<Waypoints />} title={t.flow.empty} description={t.flow.emptyHint} />
          </div>
        )}

        <div className="stage-toolbar" role="toolbar" aria-label={t.flow.title}>
          <button type="button" className="icon-btn" title={t.flow.zoomIn} aria-label={t.flow.zoomIn} onClick={() => void zoomIn()}>
            <Plus />
          </button>
          <button type="button" className="icon-btn" title={t.flow.zoomOut} aria-label={t.flow.zoomOut} onClick={() => void zoomOut()}>
            <Minus />
          </button>
          <button type="button" className="icon-btn" title={`${t.flow.fit} (f)`} aria-label={t.flow.fit} onClick={() => void fitView(FIT)}>
            <Maximize />
          </button>
          <div className="sep" />
          <button type="button" className="icon-btn" title={t.flow.relayout} aria-label={t.flow.relayout} onClick={() => void relayout()}>
            <LayoutTemplate />
          </button>
        </div>

        <div className="stage-legend" aria-hidden>
          {EDGE_KINDS.map((kind) => (
            <span key={kind}>
              <i style={{ '--port': EDGE_COLOR[kind] } as CSSProperties} /> {t.flow.edgeKinds[kind]}
            </span>
          ))}
          <span className="flow-legend-dash">{t.flow.dashedForecast}</span>
        </div>

        {!selected && !empty && <p className="stage-hint flow-hint">{t.flow.hint}</p>}

        <FlowDrawer
          selection={selected}
          base={{ from: data.from, to: data.to, caixaIds: data.caixaIds }}
          onClose={() => setSelection(null)}
          onFocus={focusNode}
          onExpand={expand}
        />
      </div>
    </EdgeHoverContext.Provider>
  );
}
