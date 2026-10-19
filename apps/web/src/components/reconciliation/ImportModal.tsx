import {
  applyCsvMapping,
  type CardOverview,
  CSV_DELIMITERS,
  CSV_ENCODINGS,
  type CsvMappingRow,
  formatDate,
  formatMonth,
  parseCsv,
  type StatementImportDetail,
  type StatementInspect,
  t,
  todayIso,
} from '@moneyflow/shared';
import { FileUp, Trash2 } from 'lucide-react';
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { upload } from '../../lib/upload';
import { Money } from '../domain';
import { FormError, ModalActions, MoneyInput } from '../forms';
import { useToast } from '../Toast';
import { Badge, Button, cx, Field, Modal, useConfirm } from '../ui';

const s = t.statements;

export type StatementTarget = { accountId: string } | { cardCaixaId: string };

const DATE_FORMATS = ['dd/MM/yyyy', 'dd/MM/yy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'dd-MM-yyyy', 'dd.MM.yyyy', 'yyyyMMdd'];

type ColKey = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'fitid' | 'balance';
type Cols = Record<ColKey, number | null>;
type MappingForm = {
  name: string;
  delimiter: (typeof CSV_DELIMITERS)[number];
  encoding: (typeof CSV_ENCODINGS)[number];
  hasHeader: boolean;
  skipRows: number;
  dateFormat: string;
  decimalSeparator: ',' | '.';
  split: boolean;
  cols: Cols;
  isDefault: boolean;
};

const EMPTY_COLS: Cols = { date: null, description: null, amount: null, debit: null, credit: null, fitid: null, balance: null };

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Palpite das colunas pelo cabeçalho (data, histórico, valor, débito/crédito, saldo). */
function guessCols(header: string[]): Cols {
  const find = (re: RegExp) => {
    const i = header.findIndex((h) => re.test(normalize(h)));
    return i >= 0 ? i : null;
  };
  return {
    date: find(/^data|date/),
    description: find(/hist|descri|lanc|memo|estabelec/),
    amount: find(/^valor|amount|^vlr/),
    debit: find(/debito|saida/),
    credit: find(/credito|entrada/),
    fitid: find(/^id$|fitid|identificador|documento/),
    balance: find(/saldo|balance/),
  };
}

/** Referência salva (índice ou nome de cabeçalho) → índice na pré-visualização. */
function refToIndex(ref: string | number | undefined, header: string[] | null): number | null {
  if (ref === undefined || ref === '') return null;
  if (typeof ref === 'number') return ref;
  if (/^\d+$/.test(ref) && !header) return Number(ref);
  const i = header?.findIndex((h) => normalize(h) === normalize(ref)) ?? -1;
  return i >= 0 ? i : null;
}

/**
 * Separador e linhas a pular: o que dá mais linhas com a largura máxima. Um
 * preâmbulo ("Extrato da conta…") antes do cabeçalho não engana o palpite.
 */
function guessLayout(text: string, fallback: MappingForm['delimiter']) {
  let best = { delimiter: fallback, skipRows: 0, header: [] as string[], score: -1 };
  for (const delimiter of CSV_DELIMITERS) {
    const rows = parseCsv(text, delimiter).slice(0, 30);
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (width < 2) continue;
    const score = rows.filter((r) => r.length === width).length * 100 + width;
    if (score > best.score) {
      const skipRows = Math.max(
        0,
        rows.findIndex((r) => r.length === width),
      );
      best = { delimiter, skipRows, header: rows[skipRows] ?? [], score };
    }
  }
  return best;
}

function decode(buffer: ArrayBuffer, encoding: string): string {
  try {
    return new TextDecoder(encoding === 'latin1' ? 'iso-8859-1' : encoding).decode(buffer);
  } catch {
    return new TextDecoder().decode(buffer);
  }
}

/** Importar extrato (conta) ou fatura (cartão): lê o arquivo, mostra o resumo do OFX ou o mapeamento do CSV, e importa. */
export function ImportModal({
  target,
  card,
  initialFile,
  onClose,
  onImported,
}: {
  target: StatementTarget;
  card: CardOverview | null;
  initialFile?: File | null;
  onClose: () => void;
  onImported: (detail: StatementImportDetail) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [inspect, setInspect] = useState<StatementInspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [bankBalance, setBankBalance] = useState<number | null>(null);
  const [bankBalanceOn, setBankBalanceOn] = useState(todayIso());
  const [invoiceId, setInvoiceId] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const isCard = 'cardCaixaId' in target;
  // OFX com várias contas (spec 009): só o extrato escolhido entra; começa pelo que casa com a conta ou pelo palpite.
  const [ofxPosition, setOfxPosition] = useState<number | null>(null);
  const ofxStatements = inspect?.format === 'ofx' ? (inspect.ofx?.statements ?? []) : [];
  const manyAccounts = ofxStatements.length > 1;
  const ofx = manyAccounts ? (ofxStatements.find((st) => st.position === ofxPosition) ?? inspect?.ofx) : inspect?.ofx;
  // Saldo do OFX (LEDGERBAL): já vale sem digitar nada; "Informar outro saldo" abre o campo (spec 009).
  const fileBalance = inspect?.format === 'ofx' ? (ofx?.ledgerBalance ?? null) : null;
  const [ownBalance, setOwnBalance] = useState(false);
  const typedBalance = !fileBalance || ownBalance ? bankBalance : null;

  async function pick(next: File) {
    setFile(next);
    setInspect(null);
    setOwnBalance(false);
    setBankBalance(null);
    setError(null);
    setBusy(true);
    try {
      const [result, bytes] = await Promise.all([upload<StatementInspect>('/api/statements/inspect', next, target), next.arrayBuffer()]);
      setInspect(result);
      setOfxPosition(result.ofx ? (result.ofx.selected ?? result.ofx.suggested) : null);
      setBuffer(bytes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialFile) void pick(initialFile);
  }, [initialFile]);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) void pick(dropped);
  }

  /** Envia o arquivo. Devolve true se importou. */
  async function doImport(mappingId?: string): Promise<boolean> {
    if (!file) return false;
    setError(null);
    setBusy(true);
    try {
      const detail = await upload<StatementImportDetail>('/api/statement-imports', file, {
        ...target,
        mappingId,
        cardInvoiceId: invoiceId || undefined,
        bankBalanceCents: typedBalance ?? undefined,
        bankBalanceOn: typedBalance !== null ? bankBalanceOn : undefined,
        ofxStatement: manyAccounts ? (ofxPosition ?? undefined) : undefined,
      });
      toast.success(s.imported(detail.lineCount, detail.skippedDuplicates ?? 0));
      onImported(detail);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'statement_duplicated') setError(s.allDuplicated);
      else if (err instanceof ApiError && err.code === 'csv_mapping_required') setError(s.mappingRequired);
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const extras = (
    <>
      {isCard && card && (
        <Field label={s.invoice} hint={s.invoiceHint}>
          <select className="field" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} aria-label={s.invoice}>
            <option value="">{s.invoiceAuto}</option>
            {card.invoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {formatMonth(invoice.referenceMonth)} · {s.invoiceStatuses[invoice.status] ?? invoice.status} · venc.{' '}
                {formatDate(invoice.dueDate)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!isCard && fileBalance && !ownBalance && (
        <div className="notice info flex flex-wrap items-center gap-2" data-testid="file-balance">
          <span className="min-w-0 flex-1">
            {s.fileBalance}: <Money cents={fileBalance.amountCents} /> em {formatDate(fileBalance.date)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOwnBalance(true);
              setBankBalanceOn(fileBalance.date);
            }}
          >
            {s.otherBalance}
          </Button>
        </div>
      )}
      {!isCard && (!fileBalance || ownBalance) && (
        <fieldset className="form-grid cols-2">
          <legend className="label">
            {s.bankBalanceOptional}
            {fileBalance && (
              <button type="button" className="link ml-2 text-[12.5px]" onClick={() => setOwnBalance(false)}>
                {s.useFileBalance}
              </button>
            )}
          </legend>
          <Field label={t.common.amount} hint={s.bankBalanceHint}>
            <MoneyInput value={bankBalance} onChange={setBankBalance} allowNegative ariaLabel={s.bankBalance} />
          </Field>
          <Field label={s.bankBalanceOn}>
            <input
              type="date"
              className="field"
              value={bankBalanceOn}
              onChange={(e) => setBankBalanceOn(e.target.value)}
              disabled={bankBalance === null}
            />
          </Field>
        </fieldset>
      )}
    </>
  );

  return (
    <Modal open title={isCard ? s.importInvoice : s.importStatement} onClose={onClose} wide>
      <div className="modal-body flex flex-col gap-4">
        <div
          className={cx('rec-drop', over && 'is-over')}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <FileUp />
          <span>
            {file ? <strong>{file.name}</strong> : s.dropHere}{' '}
            <button type="button" className="link" onClick={() => input.current?.click()}>
              {file ? 'trocar' : s.chooseFile}
            </button>
          </span>
          <span className="hint">{busy && !inspect ? s.inspecting : s.fileHint}</span>
          <input
            ref={input}
            type="file"
            className="hidden"
            accept=".ofx,.qfx,.csv,.txt,application/x-ofx,text/csv,text/plain"
            aria-label={s.chooseFile}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) void pick(chosen);
              e.target.value = '';
            }}
          />
        </div>

        {inspect?.format === 'ofx' && inspect.ofx && ofx && (
          <>
            {manyAccounts && (
              <div className="notice warn flex flex-col gap-2" data-testid="ofx-many-accounts">
                <span>{s.ofxManyAccounts(ofxStatements.length)}</span>
                {inspect.ofx.selected === null && <span>{s.ofxNeedsChoice}</span>}
                <Field label={s.ofxAccount}>
                  <select
                    className="field"
                    value={ofxPosition ?? ''}
                    onChange={(e) => setOfxPosition(e.target.value ? Number(e.target.value) : null)}
                    aria-label={s.ofxAccount}
                  >
                    <option value="">{s.ofxPickAccount}</option>
                    {ofxStatements.map((st) => (
                      <option key={st.position} value={st.position}>
                        {s.ofxAccountLabel(st)} · {st.count} {s.transactions.toLowerCase()}
                        {st.position === inspect.ofx?.selected ? ` · ${s.ofxMatchesTarget}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <div className="well">
              <div className="mb-2 flex items-center gap-2">
                <strong className="text-[13px]">{s.ofxSummary}</strong>
                <Badge tone="info">{s.ofxKind[ofx.kind] ?? ofx.kind}</Badge>
              </div>
              <dl className="kv">
                {manyAccounts && (
                  <>
                    <dt>{s.account}</dt>
                    <dd>{s.ofxAccountLabel(ofx)}</dd>
                  </>
                )}
                <dt>{s.period}</dt>
                <dd>
                  {formatDate(ofx.periodStart)} – {formatDate(ofx.periodEnd)}
                </dd>
                <dt>{s.transactions}</dt>
                <dd>{ofx.count}</dd>
                {ofx.ledgerBalance && (
                  <>
                    <dt>{s.ledgerBalance}</dt>
                    <dd>
                      <Money cents={ofx.ledgerBalance.amountCents} /> em {formatDate(ofx.ledgerBalance.date)}
                    </dd>
                  </>
                )}
              </dl>
            </div>
            {ofx.sample.length > 0 && (
              <div className="rec-preview">
                <table className="data">
                  <caption className="label text-left">{s.sample}</caption>
                  <tbody>
                    {ofx.sample.map((row, i) => (
                      <tr key={row.fitid ?? i}>
                        <td className="mono text-xs">{formatDate(row.postedOn)}</td>
                        <td>{row.description}</td>
                        <td className="num">
                          <Money cents={row.amountCents} signed />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {extras}
            <FormError>{error}</FormError>
            <ModalActions>
              <Button variant="ghost" onClick={onClose}>
                {t.common.cancel}
              </Button>
              <Button onClick={() => void doImport()} disabled={busy || (manyAccounts && ofxPosition === null)}>
                {busy ? s.importing : s.doImport}
              </Button>
            </ModalActions>
          </>
        )}

        {inspect?.format === 'csv' && inspect.csv && buffer && (
          <CsvMapper
            target={target}
            inspect={inspect}
            buffer={buffer}
            extras={extras}
            busy={busy}
            error={error}
            onCancel={onClose}
            onImport={doImport}
          />
        )}

        {!inspect && (
          <>
            <FormError>{error}</FormError>
            <ModalActions>
              <Button variant="ghost" onClick={onClose}>
                {t.common.cancel}
              </Button>
            </ModalActions>
          </>
        )}
      </div>
    </Modal>
  );
}

function CsvMapper({
  target,
  inspect,
  buffer,
  extras,
  busy,
  error,
  onCancel,
  onImport,
}: {
  target: StatementTarget;
  inspect: StatementInspect;
  buffer: ArrayBuffer;
  extras: ReactNode;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onImport: (mappingId?: string) => Promise<boolean>;
}) {
  const isCard = 'cardCaixaId' in target;
  const query = 'accountId' in target ? `accountId=${target.accountId}` : `cardCaixaId=${target.cardCaixaId}`;
  const mappings = useApi<CsvMappingRow[]>(`/api/csv-mappings?${query}`);
  const [mappingId, setMappingId] = useState<string>('new');
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { run, busy: saving } = useAction();
  const confirm = useConfirm();
  const detected = (CSV_DELIMITERS as readonly string[]).includes(inspect.csv?.delimiter ?? '')
    ? (inspect.csv!.delimiter as MappingForm['delimiter'])
    : ';';
  const detectedEncoding = (CSV_ENCODINGS as readonly string[]).includes(inspect.encoding)
    ? (inspect.encoding as MappingForm['encoding'])
    : 'utf-8';

  const fresh = (): MappingForm => {
    const layout = guessLayout(decode(buffer, detectedEncoding), detected);
    const cols = guessCols(layout.header);
    return {
      name: s.defaultMappingName,
      delimiter: layout.delimiter,
      encoding: detectedEncoding,
      hasHeader: true,
      skipRows: layout.skipRows,
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: ',',
      split: cols.amount === null && cols.debit !== null && cols.credit !== null,
      cols,
      isDefault: (mappings.data ?? []).length === 0,
    };
  };
  const [form, setForm] = useState<MappingForm>(fresh);

  // Com mapeamentos salvos, começa pelo padrão (ou o primeiro).
  useEffect(() => {
    const list = mappings.data;
    if (!list || list.length === 0) return;
    const chosen = list.find((m) => m.isDefault) ?? list[0]!;
    load(chosen);
  }, [mappings.data]);

  const text = useMemo(() => decode(buffer, form.encoding), [buffer, form.encoding]);
  const rows = useMemo(() => parseCsv(text, form.delimiter), [text, form.delimiter]);
  const headerRow = form.hasHeader ? (rows[form.skipRows] ?? null) : null;

  function load(mapping: CsvMappingRow) {
    const allRows = parseCsv(decode(buffer, mapping.encoding), mapping.delimiter);
    const header = mapping.hasHeader ? (allRows[mapping.skipRows] ?? null) : null;
    const cols = { ...EMPTY_COLS };
    for (const key of Object.keys(EMPTY_COLS) as ColKey[]) cols[key] = refToIndex(mapping.columns[key], header);
    setMappingId(mapping.id);
    setDirty(false);
    setForm({
      name: mapping.name,
      delimiter: mapping.delimiter as MappingForm['delimiter'],
      encoding: mapping.encoding as MappingForm['encoding'],
      hasHeader: mapping.hasHeader,
      skipRows: mapping.skipRows,
      dateFormat: mapping.dateFormat,
      decimalSeparator: mapping.decimalSeparator as ',' | '.',
      split: cols.amount === null,
      cols,
      isDefault: mapping.isDefault,
    });
  }

  const set = (patch: Partial<MappingForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const setCol = (key: ColKey, value: number | null) => set({ cols: { ...form.cols, [key]: value } });

  const columns = (() => {
    const out: Record<string, number> = {};
    const keys: ColKey[] = [
      'date',
      'description',
      ...(form.split ? (['debit', 'credit'] as const) : (['amount'] as const)),
      'fitid',
      'balance',
    ];
    for (const key of keys) if (form.cols[key] !== null) out[key] = form.cols[key]!;
    return out;
  })();
  const complete =
    columns.date !== undefined &&
    columns.description !== undefined &&
    (form.split ? columns.debit !== undefined && columns.credit !== undefined : columns.amount !== undefined);

  const parsed = useMemo(() => {
    if (!complete) return null;
    try {
      return applyCsvMapping(rows, {
        hasHeader: form.hasHeader,
        skipRows: form.skipRows,
        dateFormat: form.dateFormat,
        decimalSeparator: form.decimalSeparator,
        columns: columns as Parameters<typeof applyCsvMapping>[1]['columns'],
      });
    } catch (err) {
      return { headers: null, lines: [], errors: [{ row: 0, message: err instanceof Error ? err.message : String(err) }] };
    }
  }, [rows, form.hasHeader, form.skipRows, form.dateFormat, form.decimalSeparator, form.cols, form.split, complete]);

  async function submit() {
    setLocalError(null);
    if (!complete) return setLocalError(s.mappingIncomplete);
    if (!form.name.trim()) return setLocalError(`${s.mappingName}: obrigatório.`);
    const body = {
      name: form.name.trim(),
      delimiter: form.delimiter,
      encoding: form.encoding,
      hasHeader: form.hasHeader,
      skipRows: form.skipRows,
      dateFormat: form.dateFormat,
      decimalSeparator: form.decimalSeparator,
      columns,
      isDefault: form.isDefault,
    };
    let id = mappingId === 'new' ? undefined : mappingId;
    if (!id || dirty) {
      const saved = await run(
        () =>
          id
            ? api.patch<CsvMappingRow>(`/api/csv-mappings/${id}`, body)
            : api.post<CsvMappingRow>('/api/csv-mappings', {
                ...body,
                ...('accountId' in target ? { financialAccountId: target.accountId } : { cardCaixaId: target.cardCaixaId }),
              }),
        s.mappingSaved,
      );
      if (!saved) return;
      id = saved.id;
      setMappingId(saved.id);
      setDirty(false);
      void mappings.reload();
    }
    await onImport(id);
  }

  async function removeMapping() {
    if (mappingId === 'new') return;
    const ok = await confirm({ title: `${s.deleteMapping}?`, confirmLabel: t.common.delete, danger: true });
    if (!ok) return;
    if (await run(() => api.del(`/api/csv-mappings/${mappingId}`), s.mappingDeleted)) {
      setMappingId('new');
      setForm(fresh());
      void mappings.reload();
    }
  }

  const width = Math.max(0, ...rows.slice(0, 20).map((r) => r.length));
  const colOptions = Array.from({ length: width }, (_, i) => i);
  const mappedIndexes = new Set(Object.values(columns));
  const colSelect = (key: ColKey, label: string, optional?: boolean) => (
    <Field label={label}>
      <select
        className="field"
        value={form.cols[key] ?? ''}
        onChange={(e) => setCol(key, e.target.value === '' ? null : Number(e.target.value))}
        aria-label={label}
      >
        <option value="">{optional ? s.colNone : 'Escolha…'}</option>
        {colOptions.map((i) => (
          <option key={i} value={i}>
            {s.column(i, headerRow?.[i]?.trim() || null)}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={s.savedMappings} className="min-w-[220px] flex-1">
          <select
            className="field"
            value={mappingId}
            onChange={(e) => {
              const found = mappings.data?.find((m) => m.id === e.target.value);
              if (found) load(found);
              else {
                setMappingId('new');
                setForm(fresh());
                setDirty(false);
              }
            }}
          >
            <option value="new">{s.newMapping}</option>
            {mappings.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.isDefault ? ` (${s.defaultTag})` : ''}
              </option>
            ))}
          </select>
        </Field>
        {mappingId !== 'new' && (
          <Button variant="ghost" onClick={() => void removeMapping()} aria-label={s.deleteMapping} title={s.deleteMapping}>
            <Trash2 />
          </Button>
        )}
      </div>

      <fieldset className="form-grid cols-2">
        <legend className="label">{s.csvMapping}</legend>
        <Field label={s.mappingName}>
          <input
            className="field"
            value={form.name}
            maxLength={80}
            placeholder={s.mappingNamePlaceholder}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <label className="check self-end pb-2">
          <input type="checkbox" checked={form.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} />{' '}
          {isCard ? s.isDefaultCard : s.isDefault}
        </label>
        <Field label={s.delimiter}>
          <select className="field" value={form.delimiter} onChange={(e) => set({ delimiter: e.target.value as MappingForm['delimiter'] })}>
            {CSV_DELIMITERS.map((d) => (
              <option key={d} value={d}>
                {s.delimiters[d] ?? d}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.encoding}>
          <select className="field" value={form.encoding} onChange={(e) => set({ encoding: e.target.value as MappingForm['encoding'] })}>
            {CSV_ENCODINGS.map((enc) => (
              <option key={enc} value={enc}>
                {enc}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })} /> {s.hasHeader}
        </label>
        <Field label={s.skipRows}>
          <input
            type="number"
            className="field"
            min={0}
            max={100}
            value={form.skipRows}
            onChange={(e) => set({ skipRows: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          />
        </Field>
        <Field label={s.dateFormat}>
          <input
            className="field field-mono"
            list="rec-date-formats"
            value={form.dateFormat}
            maxLength={20}
            onChange={(e) => set({ dateFormat: e.target.value })}
          />
          <datalist id="rec-date-formats">
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field label={s.decimalSeparator}>
          <select className="field" value={form.decimalSeparator} onChange={(e) => set({ decimalSeparator: e.target.value as ',' | '.' })}>
            <option value=",">{s.decimalComma}</option>
            <option value=".">{s.decimalDot}</option>
          </select>
        </Field>
        <div className="span-all">
          <span className="label">{s.amountMode}</span>
          <div className="segmented" role="group" aria-label={s.amountMode}>
            <button type="button" className={!form.split ? 'active' : ''} onClick={() => set({ split: false })}>
              {s.amountSingle}
            </button>
            <button type="button" className={form.split ? 'active' : ''} onClick={() => set({ split: true })}>
              {s.amountSplit}
            </button>
          </div>
        </div>
        {colSelect('date', s.colDate)}
        {colSelect('description', s.colDescription)}
        {form.split ? (
          <>
            {colSelect('debit', s.colDebit)}
            {colSelect('credit', s.colCredit)}
          </>
        ) : (
          colSelect('amount', s.colAmount)
        )}
        {colSelect('fitid', s.colFitid, true)}
        {colSelect('balance', s.colBalance, true)}
      </fieldset>

      <div>
        <span className="label">{s.preview}</span>
        <div className="rec-preview">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {colOptions.map((i) => (
                  <th key={i} className={cx(mappedIndexes.has(i) && 'is-mapped')}>
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((row, r) => (
                <tr key={r} className={cx(r < form.skipRows && 'is-skipped', form.hasHeader && r === form.skipRows && 'is-header')}>
                  <td>{r + 1}</td>
                  {colOptions.map((i) => (
                    <td key={i} className={cx(mappedIndexes.has(i) && 'is-mapped')}>
                      {row[i] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="hint">{s.previewHint}</span>
        {parsed && (
          <p className={cx('notice mt-2', parsed.errors.length ? 'warn' : 'ok')}>
            {parsed.lines.length} linha(s) lidas
            {parsed.errors.length > 0 &&
              ` · ${parsed.errors.length} com problema (ex.: ${parsed.errors
                .slice(0, 3)
                .map((e) => (e.row ? `linha ${e.row}: ${e.message}` : e.message))
                .join('; ')})`}
          </p>
        )}
      </div>

      {extras}
      <FormError>{localError ?? error}</FormError>
      <ModalActions>
        <Button variant="ghost" onClick={onCancel}>
          {t.common.cancel}
        </Button>
        <Button onClick={() => void submit()} disabled={busy || saving || !complete}>
          {busy ? s.importing : mappingId === 'new' || dirty ? s.saveAndImport : s.importWithMapping}
        </Button>
      </ModalActions>
    </>
  );
}
