import { type CaixaSummary, t } from '@moneyflow/shared';
import { ChevronDown, CreditCard, Wallet } from 'lucide-react';
import { useApi } from '../lib/hooks';
import { Button, Menu } from './ui';

/**
 * Filtro de caixas (menu com caixas marcáveis). Vazio = todas as que o usuário
 * vê; a API acrescenta os cartões das pagadoras escolhidas.
 */
export function CaixaFilter({
  selected,
  onChange,
  includeCards = true,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  includeCards?: boolean;
}) {
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const visible = (caixas.data ?? []).filter((c) => !c.archivedAt && (includeCards || c.kind !== 'credit_card'));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]);
  return (
    <Menu
      align="right"
      trigger={(props) => (
        <Button size="sm" variant="ghost" {...props}>
          <Wallet /> {selected.length ? t.reports.caixasSelected(selected.length) : t.reports.allCaixas} <ChevronDown />
        </Button>
      )}
    >
      <div className="caixa-filter" role="group" aria-label={t.reports.caixas}>
        {visible.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            {c.kind === 'credit_card' ? <CreditCard /> : <Wallet />}
            <span className="truncate">{c.name}</span>
          </label>
        ))}
        {selected.length > 0 && (
          <>
            <div className="sep" role="separator" />
            <button type="button" className="mi" onClick={() => onChange([])}>
              {t.calendar.clearFilter}
            </button>
          </>
        )}
      </div>
    </Menu>
  );
}
