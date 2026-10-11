import { type FlowGraphData, t } from '@moneyflow/shared';
import { Waypoints } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CaixaFilter } from '../components/CaixaFilter';
import type { FlowMode } from '../components/canvas/graph';
import { MoneyFlowCanvas } from '../components/canvas/MoneyFlowCanvas';
import { LoadError } from '../components/domain';
import { PeriodPicker, periodPreset } from '../components/PeriodPicker';
import { Skel } from '../components/ui';
import { useApi } from '../lib/hooks';
import { useSetParams } from '../lib/params';

const MODES: FlowMode[] = ['realized', 'forecast', 'both'];

/**
 * Página-palco do fluxo de dinheiro (spec 014): cabeçalho com período, caixas
 * e realizado/previsto; o canvas ocupa o resto. Filtros na URL.
 */
export function FlowPage() {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const month = periodPreset('month');
  const from = params.get('from') ?? month.from;
  const to = params.get('to') ?? month.to;
  const mode = (MODES as string[]).includes(params.get('mode') ?? '') ? (params.get('mode') as FlowMode) : 'both';
  const caixaIds = useMemo(() => (params.get('caixas') ?? '').split(',').filter(Boolean), [params]);

  const qs = new URLSearchParams({ from, to });
  if (caixaIds.length) qs.set('caixaIds', caixaIds.join(','));
  const graph = useApi<FlowGraphData>(`/api/flow?${qs}`);
  const reload = graph.reload;
  const reset = useCallback(() => void reload(), [reload]);

  return (
    <>
      <div className="stage-head">
        <div className="tt">
          <span className="node-ic">
            <Waypoints />
          </span>
          <span className="min-w-0">
            <h1>{t.flow.title}</h1>
            <span className="flow-sub block">{t.flow.sub}</span>
          </span>
        </div>
        <div className="flow-controls">
          <div className="segmented" role="group" aria-label={t.flow.mode}>
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? 'active' : ''}
                aria-pressed={mode === m}
                onClick={() => setParams({ mode: m === 'both' ? null : m })}
              >
                {m === 'realized' ? t.flow.realized : m === 'forecast' ? t.flow.forecast : t.flow.both}
              </button>
            ))}
          </div>
          <PeriodPicker from={from} to={to} onChange={(p) => setParams({ from: p.from, to: p.to })} />
          <CaixaFilter selected={caixaIds} onChange={(ids) => setParams({ caixas: ids.length ? ids.join(',') : null })} />
        </div>
      </div>
      {graph.error ? (
        <div className="stage-body">
          <LoadError error={graph.error} onRetry={() => void graph.reload()} />
        </div>
      ) : !graph.data ? (
        <div className="stage-wrap flow-loading">
          <Skel h={160} w={280} />
        </div>
      ) : (
        <MoneyFlowCanvas data={graph.data} mode={mode} onReset={reset} />
      )}
    </>
  );
}
