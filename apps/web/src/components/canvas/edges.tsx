import { formatBRL, t } from '@moneyflow/shared';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { createContext, memo, useContext } from 'react';
import { cx } from '../ui';
import { EDGE_COLOR, type MoneyEdge } from './graph';

/*
 * A aresta de dinheiro: Bézier na cor do tipo (--port-N), espessura pelo
 * valor. Realizado = traço contínuo; previsto = tracejado andando (parado com
 * prefers-reduced-motion). No modo "realizado + previsto" o previsto corre
 * ao lado, levemente deslocado. O valor aparece no hover e na seleção.
 */

export const EdgeHoverContext = createContext<{ hovered: string | null }>({ hovered: null });

function MoneyEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<MoneyEdge>) {
  const { hovered } = useContext(EdgeHoverContext);
  if (!data) return null;
  const color = EDGE_COLOR[data.kind];
  const showRealized = data.mode !== 'forecast' && data.realizedCents !== 0;
  const showForecast = data.mode !== 'realized' && data.forecastCents !== 0;
  const offset = showRealized && showForecast ? Math.max(3, data.width / 2 + 2) : 0;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const [forecastPath] = getBezierPath({
    sourceX,
    sourceY: sourceY + offset,
    sourcePosition,
    targetX,
    targetY: targetY + offset,
    targetPosition,
  });
  const show = selected || hovered === id;
  const value = (showRealized ? data.realizedCents : 0) + (showForecast ? data.forecastCents : 0);

  return (
    <>
      {showRealized && (
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={18}
          className={cx('flow-edge', data.dim && 'is-dim', show && 'is-on')}
          style={{ stroke: color, strokeWidth: data.width }}
        />
      )}
      {showForecast && (
        <BaseEdge
          id={showRealized ? `${id}:forecast` : id}
          path={forecastPath}
          interactionWidth={18}
          className={cx('flow-edge flow-edge-forecast', data.dim && 'is-dim', show && 'is-on')}
          style={{ stroke: color, strokeWidth: Math.max(1.5, data.width * 0.8) }}
        />
      )}
      <EdgeLabelRenderer>
        <div
          className={cx('edge-label flow-edge-label nodrag nopan', show && 'show')}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            ['--port' as string]: color,
          }}
        >
          <span className="dot" />
          <span>{t.flow.edgeKinds[data.kind]}</span>
          <span className="money">{formatBRL(value)}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const flowEdgeTypes = { money: memo(MoneyEdgeImpl) };
