import {
  type Connection,
  type IsValidConnection,
  type NodeChange,
  type OnBeforeDelete,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { LayoutTemplate, Maximize, Minus, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storageKey } from '../../config/brand';
import { isChordKey, isTypingTarget, useRegisterCommands } from '../../lib/commands';
import { readStored, writeStored } from '../../lib/storage';
import { useTheme } from '../../lib/theme';
import { useToast } from '../Toast';
import { Button, useConfirm, usePolling } from '../ui';
import { AddNodeDialog, type NewLeaf } from './AddNodeDialog';
import { type EdgeApi, EdgeContext, edgeTypes } from './edges';
import { autoLayout, DEFAULT_HUB, freeSlot, GRID } from './layout';
import { NodeDrawer } from './NodeDrawer';
import { nodeTypes } from './nodes';
import {
  type CanvasEdge,
  type CanvasNode,
  ENTRY_ID,
  type Graph,
  HUB_ID,
  isLeaf,
  makePortEdge,
  PORTS,
  type PortEdge,
  type PortId,
  portEdgeId,
  portOfHandle,
  portStyle,
} from './types';

const FIT = { padding: 0.25, maxZoom: 1 } as const;

type Props = {
  /** Chave da persistência local do arranjo. */
  graphId: string;
  /** O grafo de partida (ou o que veio da API). */
  initial: Graph;
  canEdit?: boolean;
  /** Link do botão "Configurações" na gaveta do hub. */
  settingsTo?: string;
  /** Conexões ativas na entrada. Ausente = simulação de demonstração. */
  live?: number;
};

/**
 * O palco: React Flow com os quatro tipos de nó, a gaveta à direita, os
 * controles flutuantes (ações no topo à direita, zoom embaixo à esquerda,
 * legenda das portas embaixo à direita, dica no centro) e os atalhos
 * (a = adicionar, f = enquadrar, Esc = fechar a gaveta, Delete = remover).
 *
 * DEMONSTRAÇÃO: o grafo inteiro é salvo no localStorage. Com backend, troque
 * `persist` por chamadas à API (posição com debounce; ligação na hora, com a
 * aresta em `saving` até a resposta) e mantenha o resto.
 */
export function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ graphId, initial, canEdit = true, settingsTo, live: liveProp }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const [theme] = useTheme();
  const { fitView, zoomIn, zoomOut, deleteElements, getNode, setCenter } = useReactFlow<CanvasNode, CanvasEdge>();

  const key = storageKey(`graph:${graphId}`);
  const saved = useMemo(() => readStored<Graph | null>(key, null), [key]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(saved?.nodes ?? initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>(saved?.edges ?? initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [simulated, setSimulated] = useState(3);
  const live = liveProp ?? simulated;

  // Demonstração: conexões oscilando, para a aresta viva ter o que mostrar.
  usePolling(() => setSimulated((n) => Math.max(0, Math.min(8, n + Math.round(Math.random() * 4 - 2)))), 4000, liveProp === undefined);

  // ----------------------------------------------------------- persistência --
  useEffect(() => {
    const timer = setTimeout(() => {
      const strip = nodes.map(({ id, type, position, data }) => ({
        id,
        type,
        position,
        data,
        deletable: id !== HUB_ID && id !== ENTRY_ID,
      }));
      writeStored(key, { nodes: strip, edges: edges.map(({ selected: _s, ...edge }) => edge) });
    }, 400);
    return () => clearTimeout(timer);
  }, [key, nodes, edges]);

  // ------------------------------------------------------------- derivados --
  // Portas de cada folha, contagens do hub, conexões da entrada e seleção são
  // derivadas a cada desenho: a fonte de verdade é só `nodes` + `edges`.
  const viewNodes = useMemo<CanvasNode[]>(() => {
    const portsByTarget = new Map<string, PortId[]>();
    const counts: Record<PortId, number> = Object.fromEntries(PORTS.map((port) => [port.id, 0]));
    for (const edge of edges) {
      if (edge.type !== 'port' || !edge.data) continue;
      portsByTarget.set(edge.target, [...(portsByTarget.get(edge.target) ?? []), edge.data.port]);
      counts[edge.data.port] = (counts[edge.data.port] ?? 0) + 1;
    }
    const busy = new Set(edges.filter((edge) => edge.type === 'port' && edge.data?.saving).map((edge) => edge.target));
    return nodes.map((node) => {
      const selected = node.id === selectedId;
      if (isLeaf(node))
        return {
          ...node,
          selected,
          data: { ...node.data, ports: portsByTarget.get(node.id) ?? [], busy: busy.has(node.id) },
        } as CanvasNode;
      if (node.type === 'hub') return { ...node, selected, zIndex: 2, data: { ...node.data, counts } };
      return { ...node, selected, data: { ...node.data, live } };
    });
  }, [nodes, edges, selectedId, live]);

  const viewEdges = useMemo<CanvasEdge[]>(
    () =>
      edges.map((edge) =>
        edge.type === 'flow'
          ? { ...edge, className: `edge-flow${live > 0 ? ' live' : ''}`, data: { live } }
          : { ...edge, deletable: canEdit && !(edge as PortEdge).data?.saving },
      ),
    [edges, live, canEdit],
  );

  const selectedNode = viewNodes.find((node) => node.id === selectedId) ?? null;

  useEffect(() => {
    const timer = setTimeout(() => void fitView(FIT), 50);
    return () => clearTimeout(timer);
  }, [fitView]);

  // --------------------------------------------------------------- ligações --
  /** Liga a porta com a aresta "gravando" por um instante — o lugar da chamada à API. */
  const connect = useCallback(
    (port: PortId, target: string) => {
      const id = portEdgeId(port, target);
      setEdges((current) => (current.some((edge) => edge.id === id) ? current : [...current, makePortEdge(port, target, true)]));
      setTimeout(
        () =>
          setEdges((current) =>
            current.map((edge) => (edge.id === id && edge.type === 'port' ? { ...edge, data: { port, saving: false } } : edge)),
          ),
        600,
      );
    },
    [setEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const port = portOfHandle(connection.sourceHandle, 'out');
      if (!port || connection.source !== HUB_ID || portOfHandle(connection.targetHandle, 'in') !== port) return;
      connect(port, connection.target);
    },
    [connect],
  );

  const isValidConnection = useCallback<IsValidConnection<CanvasEdge>>(
    (connection) => {
      if (!canEdit) return false;
      const port = portOfHandle(connection.sourceHandle, 'out');
      if (!port || connection.source !== HUB_ID || portOfHandle(connection.targetHandle, 'in') !== port) return false;
      if (!isLeaf(getNode(connection.target))) return false;
      return !edges.some((edge) => edge.id === portEdgeId(port, connection.target));
    },
    [canEdit, edges, getNode],
  );

  const togglePort = useCallback(
    (nodeId: string, port: PortId, on: boolean) => {
      if (on) connect(port, nodeId);
      else void deleteElements({ edges: [{ id: portEdgeId(port, nodeId) }] });
    },
    [connect, deleteElements],
  );

  // Delete/Backspace e o botão da gaveta passam por aqui: nó pede confirmação, aresta não.
  const onBeforeDelete = useCallback<OnBeforeDelete<CanvasNode, CanvasEdge>>(
    async ({ nodes: toDelete }) => {
      if (!canEdit) return false;
      const leaves = toDelete.filter(isLeaf);
      if (leaves.length === 0) return true;
      const ok = await confirm({
        title: leaves.length === 1 ? `Remover "${leaves[0]!.data.title}" do fluxo?` : `Remover ${leaves.length} nós do fluxo?`,
        description: 'O nó e todas as ligações dele saem do canvas.',
        confirmLabel: 'Remover',
        danger: true,
      });
      if (ok && toDelete.some((node) => node.id === selectedId)) setSelectedId(null);
      return ok;
    },
    [canEdit, confirm, selectedId],
  );

  const removeNode = useCallback((id: string) => void deleteElements({ nodes: [{ id }] }), [deleteElements]);

  // ------------------------------------------------------------- adicionar --
  const openAdd = useCallback(() => setAdding((n) => n + 1), []);

  const confirmAdd = useCallback(
    (leaf: NewLeaf) => {
      const hub = nodes.find((node) => node.id === HUB_ID);
      const taken = nodes.filter(isLeaf).map((node) => node.position);
      const id = `${leaf.kind}:${leaf.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
      const base = { title: leaf.title, subtitle: id.split(':')[1]!, icon: leaf.icon || null, isActive: true };
      const node: CanvasNode =
        leaf.kind === 'group'
          ? {
              id,
              type: 'cluster',
              position: freeSlot(hub?.position ?? DEFAULT_HUB, taken),
              data: { ...base, count: 0, countLabel: ['membro', 'membros'] },
            }
          : { id, type: 'item', position: freeSlot(hub?.position ?? DEFAULT_HUB, taken), data: base };
      setNodes((current) => [...current, node]);
      for (const port of leaf.ports) connect(port, id);
      setAdding(0);
      setSelectedId(id);
      toast.success(`"${leaf.title}" adicionado.`);
    },
    [nodes, setNodes, connect, toast],
  );

  // ------------------------------------------------------------- arranjo --
  const relayout = useCallback(async () => {
    const ok = await confirm({
      title: 'Reorganizar o canvas?',
      description:
        'Recalcula todas as posições — entrada à esquerda, hub ao centro, grupos e itens em coluna por nome — e descarta o arranjo manual.',
      confirmLabel: 'Reorganizar',
    });
    if (!ok) return;
    setNodes((current) => autoLayout(current));
    setTimeout(() => void fitView(FIT), 50);
  }, [confirm, setNodes, fitView]);

  const restore = useCallback(async () => {
    const ok = await confirm({
      title: 'Restaurar o exemplo?',
      description: 'Descarta tudo o que foi alterado neste canvas.',
      confirmLabel: 'Restaurar',
      danger: true,
    });
    if (!ok) return;
    setNodes(initial.nodes);
    setEdges(initial.edges);
    setSelectedId(null);
    setTimeout(() => void fitView(FIT), 50);
  }, [confirm, initial, setNodes, setEdges, fitView]);

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

  useRegisterCommands(
    [
      ...(canEdit
        ? [{ id: 'canvas-add', label: 'Adicionar nó ao canvas', group: 'Recurso' as const, icon: <Plus />, shortcut: 'a', run: openAdd }]
        : []),
      { id: 'canvas-fit', label: 'Enquadrar o canvas', group: 'Recurso', icon: <Maximize />, shortcut: 'f', run: () => void fitView(FIT) },
      ...(canEdit
        ? [
            {
              id: 'canvas-relayout',
              label: 'Reorganizar o canvas (auto layout)',
              group: 'Recurso' as const,
              icon: <LayoutTemplate />,
              run: relayout,
            },
            {
              id: 'canvas-restore',
              label: 'Restaurar o canvas de exemplo',
              group: 'Perigo' as const,
              icon: <RotateCcw />,
              danger: true,
              run: restore,
            },
          ]
        : []),
    ],
    [canEdit, openAdd, relayout, restore],
  );

  // Atalhos do palco fora de campos de texto.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedId(null);
        return;
      }
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isChordKey(event)) return; // segunda tecla de um "g x": não é atalho de uma letra
      if (event.key === 'a' && canEdit) {
        event.preventDefault();
        openAdd();
      }
      if (event.key === 'f') {
        event.preventDefault();
        void fitView(FIT);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [canEdit, openAdd, fitView]);

  // Seleção: só o clique abre a gaveta; clicar no fundo fecha. Com
  // `selectNodesOnDrag` desligado, arrastar não seleciona.
  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      onNodesChange(changes);
      for (const change of changes) if (change.type === 'select' && change.selected) setSelectedId(change.id);
    },
    [onNodesChange],
  );

  // Hover das arestas de porta: um pequeno atraso na saída deixa o cursor
  // chegar ao rótulo (que mora num portal fora do <svg>) e clicar no ✕.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgeApi = useMemo<EdgeApi>(
    () => ({
      hovered,
      canEdit,
      hoverEnter: (id) => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        setHovered(id);
      },
      hoverLeave: () => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        leaveTimer.current = setTimeout(() => setHovered(null), 150);
      },
      removeEdge: (id) => void deleteElements({ edges: [{ id }] }),
      openEntry: () => setSelectedId(ENTRY_ID),
    }),
    [hovered, canEdit, deleteElements],
  );

  const leafCount = nodes.filter(isLeaf).length;
  const connections = selectedId ? edges.filter((edge) => edge.source === selectedId || edge.target === selectedId).length : 0;

  return (
    <EdgeContext.Provider value={edgeApi}>
      <div className="stage-wrap">
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={viewNodes}
          edges={viewEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onEdgeMouseEnter={(_event, edge) => edgeApi.hoverEnter(edge.id)}
          onEdgeMouseLeave={() => edgeApi.hoverLeave()}
          selectNodesOnDrag={false}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onBeforeDelete={onBeforeDelete}
          onPaneClick={() => setSelectedId(null)}
          nodesConnectable={canEdit}
          nodesDraggable={canEdit}
          snapToGrid
          snapGrid={[GRID, GRID]}
          minZoom={0.3}
          maxZoom={1.6}
          colorMode={theme}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          fitViewOptions={FIT}
        />

        <div className="stage-actions">
          {canEdit && (
            <Button onClick={openAdd}>
              <Plus /> Adicionar nó
            </Button>
          )}
        </div>

        <div className="stage-toolbar" role="toolbar" aria-label="Canvas">
          <button type="button" className="icon-btn" title="Aproximar" onClick={() => void zoomIn()}>
            <Plus />
          </button>
          <button type="button" className="icon-btn" title="Afastar" onClick={() => void zoomOut()}>
            <Minus />
          </button>
          <button type="button" className="icon-btn" title="Enquadrar (f)" onClick={() => void fitView(FIT)}>
            <Maximize />
          </button>
          {canEdit && (
            <>
              <div className="sep" />
              <button type="button" className="icon-btn" title="Reorganizar (auto layout)" onClick={() => void relayout()}>
                <LayoutTemplate />
              </button>
            </>
          )}
        </div>

        <div className="stage-legend" aria-hidden>
          {PORTS.map((port) => (
            <span key={port.id}>
              <i style={portStyle(port.id)} /> {port.label}
            </span>
          ))}
        </div>

        {leafCount > 0 && canEdit && !selectedNode && (
          <p className="stage-hint">
            Arraste de uma porta do hub até um nó para ligá-los · Delete remove a seleção · a adiciona · f enquadra
          </p>
        )}

        <NodeDrawer
          node={selectedNode}
          connections={connections}
          canEdit={canEdit}
          settingsTo={settingsTo}
          onClose={() => setSelectedId(null)}
          onTogglePort={togglePort}
          onRemove={removeNode}
          onFocus={focusNode}
        />

        {/* `key`: remonta a cada abertura, para o formulário nascer limpo. */}
        <AddNodeDialog key={adding} open={adding > 0} onClose={() => setAdding(0)} onConfirm={confirmAdd} />
      </div>
    </EdgeContext.Provider>
  );
}
