import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath, getSmoothStepPath } from '@xyflow/react';
import { X } from 'lucide-react';
import { createContext, memo, useContext, useMemo } from 'react';
import { type FlowEdge, type PortEdge, portDef } from './types';

/*
 * Duas arestas, uma por relação:
 * - `port` (hub → folha): Bézier estática, na cor da porta. O rótulo com o ✕
 *   aparece no hover e na seleção.
 * - `flow` (entrada → hub): smooth-step "viva" — brilho, partículas (uma por
 *   conexão, até 8) e o contador clicável no meio.
 */

/** O que as arestas pedem ao palco, sem window events. */
export type EdgeApi = {
  hovered: string | null;
  hoverEnter: (id: string) => void;
  hoverLeave: () => void;
  removeEdge: (id: string) => void;
  openEntry: () => void;
  canEdit: boolean;
};

export const EdgeContext = createContext<EdgeApi>({
  hovered: null,
  hoverEnter: () => {},
  hoverLeave: () => {},
  removeEdge: () => {},
  openEntry: () => {},
  canEdit: false,
});

function PortEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<PortEdge>) {
  const api = useContext(EdgeContext);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const port = data ? portDef(data.port) : undefined;
  const show = selected || api.hovered === id;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={16}
        className={data?.saving ? 'saving' : undefined}
        style={{ stroke: port?.color, strokeDasharray: data?.saving ? '5 4' : undefined }}
      />
      <EdgeLabelRenderer>
        <div
          className={`edge-label port nodrag nopan${show ? ' show' : ''}`}
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => api.hoverEnter(id)}
          onMouseLeave={api.hoverLeave}
        >
          <span>{port?.label ?? ''}</span>
          {api.canEdit && !data?.saving && (
            <button
              type="button"
              className="x"
              title="Remover a ligação"
              onClick={(event) => {
                event.stopPropagation();
                api.removeEdge(id);
              }}
            >
              <X />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const PARTICLE_MAX = 8;

function FlowEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const api = useContext(EdgeContext);
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const live = data?.live ?? 0;

  // Atraso aleatório por partícula: sem ele marcham em bloco e viram um
  // tracejado. Desligadas em prefers-reduced-motion.
  const particles = useMemo(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return [];
    return Array.from({ length: Math.min(PARTICLE_MAX, Math.max(0, live)) }, (_, index) => ({
      key: index,
      delay: -(Math.random() * 4).toFixed(2),
      duration: (3.6 + Math.random() * 1.2).toFixed(2),
    }));
  }, [live]);

  return (
    <>
      {live > 0 && <path d={path} className="edge-flow-glow" aria-hidden />}
      <BaseEdge id={id} path={path} />
      {particles.map((particle) => (
        <circle
          key={particle.key}
          r={2.2}
          className="edge-particle"
          style={{
            offsetPath: `path("${path}")`,
            offsetRotate: '0deg',
            animation: `flow-in ${particle.duration}s linear ${particle.delay}s infinite`,
          }}
        />
      ))}
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-label nodrag nopan${live > 0 ? ' live' : ''}`}
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title="Conexões ativas agora — clique para ver os detalhes"
          onClick={api.openEntry}
        >
          <span className="dot" />
          <span className="n">{live}</span> {live === 1 ? 'conexão ativa' : 'conexões ativas'}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = {
  port: memo(PortEdgeImpl),
  flow: memo(FlowEdgeImpl),
};
