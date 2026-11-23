import {
  type AgentPromptPreviewDto,
  type AgentPromptVersionDto,
  type AiAgentDto,
  formatDateTime,
  PROMPT_VARIABLES,
  t,
  type UserRow,
} from '@moneyflow/shared';
import { ArrowLeft, Eye } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LineDiff } from '../diff/LineDiff';
import { VersionCompare, type VersionItem } from '../diff/VersionCompare';
import { LoadError } from '../domain';
import { ModalActions } from '../forms';
import { Badge, Button, Field, useConfirm } from '../ui';

/*
 * Prompt do agente (spec 022): a lista de variáveis (clicar insere), o
 * histórico de versões com diff e restaurar, e o "Ver prompt montado". O
 * histórico e o prompt montado abrem dentro do próprio formulário do agente
 * (sem modal sobre modal).
 */

const g = t.agentsUi.admin.agents;
const p = t.agentsUi.admin.prompt;

export function PromptVariables({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div>
      <span className="label">{g.variables}</span>
      <p className="hint !mt-0 mb-1.5">{g.variablesHint}</p>
      <div className="flex flex-wrap gap-1.5" data-testid="prompt-variables">
        {PROMPT_VARIABLES.map((v) => (
          <button
            key={v.name}
            type="button"
            className="prompt-var"
            title={`${v.description}${v.kind === 'volatile' ? ` (${g.variableVolatile})` : ''}`}
            onClick={() => onInsert(`{{${v.name}}}`)}
          >
            {`{{${v.name}}}`}
            {v.kind === 'volatile' && <span className="text-faint"> ·</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Histórico das versões: conteúdo de uma, diff entre duas (A → B) e restaurar. */
export function PromptHistory({
  agent,
  onBack,
  onRestored,
}: {
  agent: AiAgentDto;
  onBack: () => void;
  onRestored: (agent: AiAgentDto) => void;
}) {
  const { data, error, reload } = useApi<AgentPromptVersionDto[]>(`/api/admin/ai/agents/${agent.id}/prompt-versions`);
  const confirm = useConfirm();
  const { run } = useAction();
  const current = data?.[0]?.id ?? null;
  const byId = useMemo(() => new Map((data ?? []).map((v) => [v.id, v])), [data]);
  const items: VersionItem[] = (data ?? []).map((v) => ({
    id: v.id,
    version: v.version,
    current: v.id === current,
    testId: `prompt-version-${v.version}`,
    title: (
      <>
        {g.promptVersion(v.version)} {v.id === current && <Badge tone="ok">{p.current}</Badge>}
      </>
    ),
    sub: `${formatDateTime(v.createdAt)} · ${v.createdByUsername ? `@${v.createdByUsername}` : p.unknownAuthor}${v.note ? ` · ${v.note}` : ''}`,
  }));

  async function restore(item: VersionItem): Promise<boolean> {
    const ok = await confirm({ title: p.restoreConfirm(item.version), description: p.restoreDescription, confirmLabel: p.restore });
    if (!ok) return false;
    const saved = await run(
      () => api.post<AiAgentDto>(`/api/admin/ai/agents/${agent.id}/prompt-versions/${item.id}/restore`),
      p.restored(item.version),
    );
    if (!saved) return false;
    await reload();
    onRestored(saved);
    return true;
  }

  return (
    <>
      <div className="modal-body form-grid">
        {error && <LoadError error={error} onRetry={() => void reload()} />}
        {data && data.length === 0 && <p className="hint">{p.versionsEmpty}</p>}
        <VersionCompare
          items={items}
          name="prompt"
          labels={{ compareA: p.compareA, compareB: p.compareB, restore: p.restore, compare: p.showDiff, compareHint: p.compare }}
          canRestore
          onRestore={restore}
          renderContent={(id) => (
            <pre className="panel contract-raw" data-testid="prompt-version-content">
              {byId.get(id)?.content || p.emptyPrompt}
            </pre>
          )}
          renderDiff={(left, right) => {
            const before = byId.get(left);
            const after = byId.get(right);
            if (!before || !after) return null;
            return (
              <LineDiff
                before={before.content}
                after={after.content}
                title={p.diffTitle(before.version, after.version)}
                noDiff={p.noDiff}
                testId="prompt-diff"
              />
            );
          }}
          className="grid gap-3"
          listClassName="max-h-[38vh] overflow-auto"
          listTestId="prompt-versions"
        />
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> {t.common.back}
        </Button>
      </ModalActions>
    </>
  );
}

/** "Ver prompt montado": escolhe um usuário e mostra o prompt final, com os pontos de cache, sem chamar o modelo. */
export function PromptPreview({ agent, dirty, onBack }: { agent: AiAgentDto; dirty: boolean; onBack: () => void }) {
  const users = useApi<UserRow[]>('/api/users');
  const [userId, setUserId] = useState('');
  const [preview, setPreview] = useState<AgentPromptPreviewDto | null>(null);
  const { run, busy } = useAction();

  async function build(id: string) {
    setUserId(id);
    setPreview(null);
    if (!id) return;
    const result = await run(() => api.post<AgentPromptPreviewDto>(`/api/admin/ai/agents/${agent.id}/prompt-preview`, { userId: id }));
    if (result) setPreview(result);
  }

  return (
    <>
      <div className="modal-body form-grid">
        <p className="panel-hint">{p.previewHint}</p>
        {dirty && <p className="notice mt-0">{p.previewSaveFirst}</p>}
        <Field label={p.previewUser}>
          <select className="field" value={userId} onChange={(e) => void build(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {(users.data ?? [])
              .filter((u) => u.isActive)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  @{u.username}
                </option>
              ))}
          </select>
        </Field>
        {preview?.volatileVariables && <p className="notice warn mt-0">{g.volatileWarning}</p>}
        {preview && (
          <div className="grid gap-2" data-testid="prompt-preview">
            {preview.parts.map((part, index) => (
              <div key={`${part.kind}-${index}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="label !mb-0">{p.parts[part.kind]}</span>
                  <span className="text-[11.5px] text-faint">{p.chars(part.text.length)}</span>
                </div>
                <pre className="panel contract-raw !max-h-[30vh]">{part.text}</pre>
                {part.cacheBreakpoint && (
                  <p className="prompt-cache-mark" data-testid="prompt-cache-mark">
                    {p.cacheBreakpoint} {index + 1}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        {!preview && !busy && (
          <p className="hint">
            <Eye className="inline size-4" /> {p.previewUser}
          </p>
        )}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> {t.common.back}
        </Button>
      </ModalActions>
    </>
  );
}
