import {
  formatDateTime,
  type ImportRecipesDto,
  type ReconcileRecipeDto,
  type ReconcileRecipeRunDto,
  type ReconcileRecipeRunResult,
  recipeSkipReasonText,
  t,
} from '@moneyflow/shared';
import { BookOpenCheck, Loader2, Play } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAgents } from '../../agents/AgentsProvider';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { Badge, Button, type Tone } from '../ui';

const k = t.agentsUi.recipes;

export const RECIPE_RUN_TONE: Record<string, Tone> = {
  queued: 'outline',
  started: 'info',
  completed: 'ok',
  skipped: 'outline',
  failed: 'danger',
};

/** Status de uma execução de receita: a da ai_runs enquanto roda (esperando aprovação etc.), senão o da receita. */
export function recipeRunLabel(run: ReconcileRecipeRunDto): { label: string; tone: Tone; title?: string } {
  if (run.status === 'started' && run.runStatus) {
    return {
      label: t.agentsUi.tasks.runStatus[run.runStatus] ?? run.runStatus,
      tone: run.runStatus === 'awaiting_confirmation' ? 'warn' : 'info',
      title: run.runError ?? undefined,
    };
  }
  return {
    label: k.status[run.status] ?? run.status,
    tone: RECIPE_RUN_TONE[run.status] ?? 'neutral',
    title: recipeSkipReasonText(run.skipReason),
  };
}

/**
 * Painel Receitas da tela do lote (spec 030): as receitas que valem para o
 * lote (as da conta primeiro), cada uma com o play no escopo (as linhas
 * pendentes selecionadas ou todas as pendentes), e as execuções deste lote.
 * O andamento e o lote de aprovações ficam no painel da conciliação com IA
 * (ReconcileAiPanel), remontado por `onStarted` quando uma execução começa.
 */
export function RecipesPanel({
  importId,
  selectedLineIds,
  version,
  onStarted,
}: {
  importId: string;
  /** Linhas pendentes selecionadas na tabela (vazio = todas as pendentes). */
  selectedLineIds: string[];
  /** Muda quando o lote muda (recarrega). */
  version: number;
  onStarted: () => void;
}) {
  const { data, reload } = useApi<ImportRecipesDto>(`/api/statement-imports/${importId}/recipes`);
  const { run, busy } = useAction();
  const agents = useAgents();
  const started = useRef(onStarted);
  started.current = onStarted;
  const lastStarted = useRef<string | null>(null);

  // Recarrega quando o lote muda (a primeira carga é a do useApi).
  useEffect(() => {
    if (version > 0) void reload();
  }, [version, reload]);

  // Enquanto a fila do import anda (uma receita por vez), relê; a cada execução nova, o painel da IA é remontado.
  const queued = data?.runs.some((r) => r.status === 'queued' || r.status === 'started') ?? false;
  useEffect(() => {
    if (!queued) return;
    const timer = setInterval(() => void reload(), 4000);
    return () => clearInterval(timer);
  }, [queued, reload]);
  const current = data?.runs.find((r) => r.status === 'started')?.id ?? null;
  useEffect(() => {
    if (current && lastStarted.current && current !== lastStarted.current) started.current();
    lastStarted.current = current;
  }, [current]);

  if (!data || (data.recipes.length === 0 && data.runs.length === 0)) return null;

  async function play(recipe: ReconcileRecipeDto) {
    const result = await run(
      () =>
        api.post<ReconcileRecipeRunResult>(
          `/api/statement-imports/${importId}/recipes/${recipe.id}/run`,
          selectedLineIds.length ? { lineIds: selectedLineIds } : {},
        ),
      k.started(recipe.name),
    );
    if (!result) return;
    lastStarted.current = result.run.id;
    void reload();
    started.current();
  }

  const scope = selectedLineIds.length ? k.scopeSelected(selectedLineIds.length) : k.scopePending(data.pendingLines);
  const running = data.runs.find((r) => r.status === 'started' && (r.runStatus === 'queued' || r.runStatus === 'running'));

  return (
    <div className="well mb-3 grid gap-2" data-testid="recipes-panel">
      <div className="flex flex-wrap items-center gap-3">
        <BookOpenCheck className="size-4 flex-none" />
        <strong className="text-[13px]">{k.panelTitle}</strong>
        <span className="text-xs text-faint">{scope}</span>
        <span className="flex-1" />
        <Link className="link text-[13px]" to="/reconcile-recipes">
          {k.manage}
        </Link>
      </div>
      {running && (
        <div className="notice info flex items-center gap-2">
          <Loader2 className="spin size-4 flex-none" />
          <span>{k.running(running.recipeName)}</span>
        </div>
      )}
      {data.recipes.length === 0 ? (
        <p className="hint">{k.panelEmpty}</p>
      ) : (
        <ul className="grid gap-1">
          {data.recipes.map((recipe) => (
            <li key={recipe.id} className="flex flex-wrap items-center gap-2" data-testid="recipe-item">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || data.busy || !data.canRun || data.pendingLines === 0}
                onClick={() => void play(recipe)}
                title={k.playTitle(recipe.name)}
                aria-label={k.playTitle(recipe.name)}
                data-testid="recipe-play"
              >
                <Play /> {k.play}
              </Button>
              <span className="text-[13px]">{recipe.name}</span>
              <Badge tone="outline">{recipe.linked ? k.linked : recipe.caixaId ? k.caixa : k.global}</Badge>
              <span className="text-xs text-faint">{recipe.agentName}</span>
              {!recipe.agentHasKit && <span className="text-xs text-warn">{k.noKit(recipe.agentName)}</span>}
            </li>
          ))}
        </ul>
      )}
      {data.busy && !running && <p className="hint">{k.busy}</p>}
      {data.runs.length > 0 && (
        <details>
          <summary className="text-[13px]">
            {k.runsTitle} ({data.runs.length})
          </summary>
          <ul className="mt-1 grid gap-1">
            {data.runs.map((r) => {
              const label = recipeRunLabel(r);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="mono text-xs">{formatDateTime(r.createdAt)}</span>
                  <span>{r.recipeName}</span>
                  <Badge tone={label.tone}>
                    <span title={label.title}>{label.label}</span>
                  </Badge>
                  <span className="text-xs text-faint">
                    {k.trigger[r.triggerKind]} · {k.lines(r.lineCount)} · {k.by(r.username)}
                  </span>
                  {r.conversationId && (
                    <button type="button" className="link" onClick={() => void agents.openById(r.conversationId!)}>
                      {k.openSession}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

/** No cadastro da conta e do cartão: as receitas que rodam ao importar, na ordem, com o link para a tela de receitas. */
export function ImportRecipesHint({ accountId, cardCaixaId }: { accountId?: string; cardCaixaId?: string }) {
  const qs = accountId ? `accountId=${accountId}` : `cardCaixaId=${cardCaixaId}`;
  const { data } = useApi<ReconcileRecipeDto[]>(accountId || cardCaixaId ? `/api/reconcile-recipes?${qs}` : null);
  const onImport = (data ?? []).filter((r) => r.runOnImport && r.isActive).sort((a, b) => a.position - b.position);
  if (!data) return null;
  return (
    <div className="hint" data-testid="import-recipes">
      <strong>{k.onImport}:</strong> {onImport.length === 0 ? k.onImportEmpty : onImport.map((r, i) => `${i + 1}. ${r.name}`).join(' · ')}{' '}
      <Link className="link" to="/reconcile-recipes">
        {k.manage}
      </Link>
    </div>
  );
}
