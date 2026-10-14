import { type CaixaSummary, t, type UserAiSettingsDto } from '@moneyflow/shared';
import { Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError } from '../domain';
import { Button, Field, Panel } from '../ui';

const a = t.agentsUi.account;
const MAX = 20_000;

/** Minha conta → IA (spec 022): instruções para todos os agentes e a caixa principal (uma caixa comum que eu leio). */
export function AiSettingsPanel() {
  const settings = useApi<UserAiSettingsDto>('/api/account/ai');
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const [instructions, setInstructions] = useState('');
  const [primaryCaixaId, setPrimaryCaixaId] = useState('');
  const { run, busy } = useAction();

  useEffect(() => {
    if (!settings.data) return;
    setInstructions(settings.data.instructions);
    setPrimaryCaixaId(settings.data.primaryCaixaId ?? '');
  }, [settings.data]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () => api.put<UserAiSettingsDto>('/api/account/ai', { instructions, primaryCaixaId: primaryCaixaId || null }),
      a.saved,
    );
    if (saved) settings.setData(saved);
  }

  const general = (caixas.data ?? []).filter((c) => c.kind === 'general');
  return (
    <Panel title={a.title} icon={<Sparkles />}>
      <p className="panel-hint">{a.hint}</p>
      {settings.error ? (
        <LoadError error={settings.error} onRetry={() => void settings.reload()} />
      ) : (
        <form onSubmit={submit} className="form-grid mt-3" data-testid="account-ai">
          <Field label={a.instructions} hint={a.instructionsHint}>
            <textarea
              className="field"
              rows={6}
              value={instructions}
              maxLength={MAX}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={!settings.data}
            />
          </Field>
          <p className="hint !mt-0 text-right">{a.chars(instructions.length, MAX)}</p>
          <Field label={a.primaryCaixa} hint={a.primaryHint}>
            <select className="field" value={primaryCaixaId} onChange={(e) => setPrimaryCaixaId(e.target.value)}>
              <option value="">{a.primaryNone}</option>
              {general.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {primaryCaixaId && settings.data?.primaryCaixaId === primaryCaixaId && !general.some((c) => c.id === primaryCaixaId) && (
                <option value={primaryCaixaId}>{settings.data.primaryCaixaName ?? primaryCaixaId}</option>
              )}
            </select>
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !settings.data}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
