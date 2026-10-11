import { type AiPriceDto, type AiProviderDto, formatDateTime, t } from '@moneyflow/shared';
import { CircleDollarSign, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Button, EmptyRow, EmptyState, Field, Modal, useConfirm } from '../ui';
import { ANTHROPIC_SUGGESTIONS, optionalNumber, useProviderModels } from './shared';

const p = t.agentsUi.admin.prices;

const price = (value: number | null, currency: string) =>
  value === null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency, maximumFractionDigits: 4 }).format(value);

/** Preços por modelo (por milhão de tokens), com vigência: o custo de cada chamada usa o preço vigente. */
export function PricesTab() {
  const { data, error, reload } = useApi<AiPriceDto[]>('/api/admin/ai/prices');
  const providers = useApi<AiProviderDto[]>('/api/admin/ai/providers');
  const [creating, setCreating] = useState(false);
  const confirm = useConfirm();
  const { run } = useAction();

  async function remove(row: AiPriceDto) {
    if (!(await confirm({ title: p.removeConfirm(row.model), confirmLabel: t.common.remove, danger: true }))) return;
    if (await run(() => api.del(`/api/admin/ai/prices/${row.id}`), p.removed)) void reload();
  }

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setCreating(true)} disabled={!providers.data?.length}>
          <Plus /> {p.new}
        </Button>
      </div>
      {data && data.length === 0 ? (
        <EmptyState icon={<CircleDollarSign />} title={p.empty} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{p.provider}</th>
                <th>{p.model}</th>
                <th className="num">{p.input}</th>
                <th className="num">{p.output}</th>
                <th className="num">{p.cacheWrite}</th>
                <th className="num">{p.cacheRead}</th>
                <th>{p.validFrom}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={8} />}
              {data?.length === 0 && <EmptyRow colSpan={8}>{p.empty}</EmptyRow>}
              {data?.map((row) => (
                <tr key={row.id}>
                  <td>{row.providerName}</td>
                  <td className="mono text-xs">{row.model}</td>
                  <td className="num mono text-xs">{price(row.inputPricePerMillion, row.currency)}</td>
                  <td className="num mono text-xs">{price(row.outputPricePerMillion, row.currency)}</td>
                  <td className="num mono text-xs">{price(row.cacheWritePricePerMillion, row.currency)}</td>
                  <td className="num mono text-xs">{price(row.cacheReadPricePerMillion, row.currency)}</td>
                  <td className="mono text-xs">{formatDateTime(row.validFrom)}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="row-action danger"
                      title={t.common.remove}
                      aria-label={t.common.remove}
                      onClick={() => void remove(row)}
                    >
                      <Trash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <PriceFormModal
          providers={(providers.data ?? []).filter((x) => !x.archivedAt)}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

function PriceFormModal({ providers, onClose, onSaved }: { providers: AiProviderDto[]; onClose: () => void; onSaved: () => void }) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'BRL'>('USD');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cacheWrite, setCacheWrite] = useState('');
  const [cacheRead, setCacheRead] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [models] = useProviderModels();
  const { run, busy } = useAction();
  const listId = useId();
  const provider = providers.find((x) => x.id === providerId);
  const suggestions = [...new Set([...(models[providerId] ?? []), ...(provider?.kind === 'anthropic' ? ANTHROPIC_SUGGESTIONS : [])])];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const inputPrice = optionalNumber(input);
    const outputPrice = optionalNumber(output);
    if (inputPrice === undefined || outputPrice === undefined) return setError(t.errors.generic);
    setError(null);
    const saved = await run(
      () =>
        api.post<AiPriceDto>('/api/admin/ai/prices', {
          providerId,
          model: model.trim(),
          currency,
          inputPricePerMillion: inputPrice,
          outputPricePerMillion: outputPrice,
          cacheWritePricePerMillion: optionalNumber(cacheWrite) ?? null,
          cacheReadPricePerMillion: optionalNumber(cacheRead) ?? null,
          ...(validFrom ? { validFrom: new Date(validFrom).toISOString() } : {}),
        }),
      p.created,
    );
    if (saved) onSaved();
  }

  const num = (label: string, value: string, set: (v: string) => void, required = false) => (
    <Field label={label}>
      <input
        className="field field-mono"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder="0,00"
        required={required}
        pattern="[0-9]+([.,][0-9]+)?"
      />
    </Field>
  );

  return (
    <Modal open title={p.new} onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="modal-body form-grid">
          <div className="form-grid cols-2">
            <Field label={p.provider}>
              <select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
                {providers.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={p.currency}>
              <select className="field" value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'BRL')}>
                <option value="USD">USD</option>
                <option value="BRL">BRL</option>
              </select>
            </Field>
          </div>
          <Field label={p.model}>
            <input
              className="field field-mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={listId}
              required
              spellCheck={false}
              autoFocus
            />
            <datalist id={listId}>
              {suggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <div className="form-grid cols-2">
            {num(p.input, input, setInput, true)}
            {num(p.output, output, setOutput, true)}
            {num(p.cacheWrite, cacheWrite, setCacheWrite)}
            {num(p.cacheRead, cacheRead, setCacheRead)}
          </div>
          <Field label={p.validFrom} hint={p.validFromHint}>
            <input className="field" type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !providerId || !model.trim()}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
