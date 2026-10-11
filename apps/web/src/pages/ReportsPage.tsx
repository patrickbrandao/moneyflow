import {
  addDays,
  addMonths,
  type CategoryReportData,
  type EntityReportData,
  formatDate,
  type ProjectionReportData,
  type ReportBasis,
  t,
  todayIso,
} from '@moneyflow/shared';
import { Building2, ChartColumn, TrendingUp } from 'lucide-react';
import { useMemo } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { CaixaFilter } from '../components/CaixaFilter';
import { LoadError, PageHead } from '../components/domain';
import { ExportMenu } from '../components/ExportMenu';
import { PeriodPicker } from '../components/PeriodPicker';
import { CategoryReport, categoryExport } from '../components/reports/CategoryReport';
import { EntityReport, entityExport } from '../components/reports/EntityReport';
import { ProjectionReport, projectionExport } from '../components/reports/ProjectionReport';
import { Skel, Tabs } from '../components/ui';
import { useApi } from '../lib/hooks';
import { useSetParams } from '../lib/params';

type Tab = 'categories' | 'projection' | 'entities';
const TABS: Tab[] = ['categories', 'projection', 'entities'];
const ICONS = { categories: <ChartColumn />, projection: <TrendingUp />, entities: <Building2 /> };

/** Últimos 6 meses fechando no mês corrente. */
function defaultPeriod() {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  return { from: addMonths(monthStart, -5), to: addDays(addMonths(monthStart, 1), -1) };
}

/**
 * Relatórios (spec 014): por categoria (competência ou caixa, por caixa ou
 * consolidado), fluxo projetado 30/60/90 e por entidade. Filtros na URL;
 * exportação CSV/PDF da aba aberta.
 */
export function ReportsPage() {
  const { tab: tabParam } = useParams();
  const tab: Tab = (TABS as string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'categories';
  const location = useLocation();
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const period = defaultPeriod();
  const from = params.get('from') ?? period.from;
  const to = params.get('to') ?? period.to;
  const basis: ReportBasis = params.get('basis') === 'cash' ? 'cash' : 'competence';
  const kind = params.get('kind') === 'income' ? 'income' : 'expense';
  const caixaIds = useMemo(() => (params.get('caixas') ?? '').split(',').filter(Boolean), [params]);
  const scope = params.get('scope'); // null = consolidado

  useAgentScreenContext({
    title: t.nav.reports,
    filters: { report: tab, from, to, basis, kind, caixas: caixaIds.join(',') || null, scope },
  });

  const qs = new URLSearchParams({ from, to, basis });
  if (caixaIds.length) qs.set('caixaIds', caixaIds.join(','));
  const categories = useApi<CategoryReportData>(tab === 'categories' ? `/api/reports/categories?${qs}` : null);
  const entities = useApi<EntityReportData>(tab === 'entities' ? `/api/reports/entities?${qs}` : null);
  const projection = useApi<ProjectionReportData>(
    tab === 'projection' ? `/api/reports/projection${caixaIds.length ? `?caixaIds=${caixaIds.join(',')}` : ''}` : null,
  );

  const scopeCaixas = (tab === 'categories' ? categories.data?.caixas : entities.data?.caixas) ?? [];
  const scopeName = scope ? scopeCaixas.find((c) => c.id === scope)?.name : null;
  const subtitle = [
    tab === 'projection' ? '' : `${formatDate(from)} – ${formatDate(to)} · ${t.reports.basis}: ${t.reports.bases[basis]}`,
    scope ? `${t.reports.byCaixa}: ${scopeName ?? ''}` : t.reports.consolidated,
  ].filter(Boolean);

  const exportBuild = () => {
    if (tab === 'categories' && categories.data) return categoryExport(categories.data, kind, scope, subtitle);
    if (tab === 'entities' && entities.data) return entityExport(entities.data, scope, subtitle);
    if (tab === 'projection' && projection.data) return projectionExport(projection.data, subtitle.slice(1));
    throw new Error(t.common.loading);
  };
  const ready = tab === 'categories' ? categories.data : tab === 'entities' ? entities.data : projection.data;

  return (
    <div className="page wide">
      <PageHead title={t.nav.reports} sub={t.reports.pageSub} actions={<ExportMenu size="md" disabled={!ready} build={exportBuild} />} />
      <Tabs
        value={tab}
        items={TABS.map((key) => ({
          key,
          label: t.reports.tabs[key]!,
          icon: ICONS[key],
          to: `/reports${key === 'categories' ? '' : `/${key}`}${location.search}`,
        }))}
      />

      <div className="report-toolbar">
        {tab !== 'projection' && (
          <>
            <div className="segmented" role="group" aria-label={t.reports.basis} title={t.reports.basisHint[basis]}>
              {(['competence', 'cash'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={basis === b ? 'active' : ''}
                  aria-pressed={basis === b}
                  onClick={() => setParams({ basis: b === 'competence' ? null : b })}
                >
                  {t.reports.bases[b]}
                </button>
              ))}
            </div>
            <PeriodPicker from={from} to={to} onChange={(p) => setParams({ from: p.from, to: p.to })} />
          </>
        )}
        <CaixaFilter
          selected={caixaIds}
          includeCards={tab !== 'projection'}
          onChange={(ids) => setParams({ caixas: ids.length ? ids.join(',') : null, scope: null })}
        />
        {tab !== 'projection' && (
          <select
            className="field field-auto field-sm"
            value={scope ?? ''}
            onChange={(e) => setParams({ scope: e.target.value || null })}
            aria-label={t.reports.view}
            title={t.reports.consolidatedHint}
          >
            <option value="">{t.reports.consolidated}</option>
            <optgroup label={t.reports.byCaixa}>
              {scopeCaixas
                .filter((c) => c.kind === 'general')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          </select>
        )}
        {tab === 'categories' && (
          <div className="segmented" role="group" aria-label={t.reports.category}>
            {(['expense', 'income'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={kind === k ? 'active' : ''}
                aria-pressed={kind === k}
                onClick={() => setParams({ kind: k === 'expense' ? null : k })}
              >
                {k === 'expense' ? t.reports.expense : t.reports.income}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'categories' &&
        (categories.error ? (
          <LoadError error={categories.error} onRetry={() => void categories.reload()} />
        ) : !categories.data ? (
          <Skel h={360} />
        ) : (
          <CategoryReport data={categories.data} kind={kind} scope={scope} />
        ))}
      {tab === 'entities' &&
        (entities.error ? (
          <LoadError error={entities.error} onRetry={() => void entities.reload()} />
        ) : !entities.data ? (
          <Skel h={360} />
        ) : (
          <EntityReport data={entities.data} scope={scope} />
        ))}
      {tab === 'projection' &&
        (projection.error ? (
          <LoadError error={projection.error} onRetry={() => void projection.reload()} />
        ) : !projection.data ? (
          <Skel h={360} />
        ) : (
          <ProjectionReport data={projection.data} />
        ))}
    </div>
  );
}
