import { type AppSettingDto, t } from '@moneyflow/shared';
import { Globe, RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { AgentTasksPanel } from '../account/AgentTasksPanel';
import { LoadError } from '../domain';
import { Badge, Button, Field, Panel } from '../ui';

const k = t.agentsUi.telegram;
const u = t.agentsUi.admin.usage;
const KEY = 'telegram.public_base_url';

/** /admin/ai → Tarefas e Telegram (spec 029): as tarefas de todos e a URL pública do webhook do Telegram. */
export function AutonomousTab() {
  return (
    <div className="grid gap-4">
      <AgentTasksPanel admin />
      <PublicUrlPanel />
    </div>
  );
}

/** telegram.public_base_url: o valor do banco vence PUBLIC_BASE_URL; "Usar o padrão" apaga o do banco. */
function PublicUrlPanel() {
  const { data, error, reload, setData } = useApi<AppSettingDto>(`/api/admin/settings/${KEY}`);
  const [value, setValue] = useState('');
  const { run, busy } = useAction();
  useEffect(() => {
    if (data) setValue(typeof data.value === 'string' ? data.value : '');
  }, [data]);
  const save = async () => {
    const saved = await run(() => api.put<AppSettingDto>(`/api/admin/settings/${KEY}`, { value: value.trim() }), k.publicUrlSaved);
    if (saved) setData(saved);
  };
  const reset = async () => {
    const saved = await run(() => api.del<AppSettingDto>(`/api/admin/settings/${KEY}`), k.publicUrlReset);
    if (saved) setData(saved);
  };
  return (
    <Panel title={k.publicUrl} icon={<Globe />}>
      <p className="panel-hint mb-3">{k.publicUrlHint}</p>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="flex flex-wrap items-end gap-3" data-testid="public-url">
          <Field label={k.publicUrl} className="min-w-[320px] flex-1">
            <input
              className="field field-mono"
              type="url"
              placeholder="https://moneyflow.exemplo.com.br"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              data-testid="public-url-input"
            />
          </Field>
          <Button disabled={busy || !data || !value.trim() || value.trim() === data.value} onClick={() => void save()}>
            <Save /> {t.common.save}
          </Button>
          <Button variant="ghost" disabled={busy || data?.source !== 'database'} onClick={() => void reset()}>
            <RotateCcw /> {u.useDefault}
          </Button>
          {data && (
            <span className="pb-2 text-xs text-faint">
              <Badge tone={data.source === 'database' ? 'accent' : 'outline'}>
                {data.source === 'database' ? u.fromDb : u.fromEnv(data.envName ?? '', String(data.envValue ?? '—'))}
              </Badge>
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}
