import { t } from '@moneyflow/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { useStored } from '../../lib/storage';
import { Badge, useConfirm } from '../ui';

const a = t.agentsUi.admin;

/** Modelos listados no último "Testar conexão" de cada provedor (sugestões na tela do agente). */
export function useProviderModels() {
  return useStored<Record<string, string[]>>('ai-provider-models', {});
}

/** Sugestões fixas para a Claude API, além das que o teste listar. */
export const ANTHROPIC_SUGGESTIONS = ['claude-sonnet-5-5', 'claude-opus-5-5'];

export function ActiveBadge({ active, archived }: { active: boolean; archived?: boolean }) {
  if (archived) return <Badge tone="outline">{a.archived}</Badge>;
  return <Badge tone={active ? 'ok' : 'neutral'}>{active ? a.active : a.inactive}</Badge>;
}

/** Remover (ou arquivar, se tiver vínculos) com confirmação. */
export function useRemove() {
  const confirm = useConfirm();
  const { run } = useAction();
  return async (path: string, name: string, onDone: () => void) => {
    const ok = await confirm({
      title: a.deleteConfirm(name),
      description: a.deleteDescription,
      confirmLabel: t.common.remove,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () => api.del<{ deleted: boolean; archived?: boolean }>(path),
      (r) => t.common.deletedOrArchived(Boolean(r.archived)),
    );
    if (result) onDone();
  };
}

/** Número opcional de um input ("" = undefined). */
export function optionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}
