import {
  type DocumentReadingDto,
  formatAccounting,
  formatDate,
  formatDocument,
  type NfeEntryResult,
  type PixEntryResult,
  parseBoleto,
  parseBrCode,
  t,
} from '@moneyflow/shared';
import { Barcode, FileCode2, FileScan, Loader2, ScanText, Sparkles, UserPlus, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import '../../styles/attachments.css';
import { ApiError, api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { upload } from '../../lib/upload';
import { MAX_ATTACHMENT_BYTES } from '../attachments/AttachmentsPanel';
import type { EntityOption } from '../forms';
import { Badge, Button, cx, Field, useDebounced } from '../ui';

/** O que a fonte preencheu no formulário do título. */
export type EntryPatch = {
  entity?: EntityOption;
  amountCents?: number;
  dueDate?: string;
  competenceDate?: string;
  description?: string;
  boletoBarcode?: string | null;
  pixPayload?: string | null;
  nfeDocumentId?: string | null;
  installments?: { count: number; amountCents: number };
};

type Source = 'boleto' | 'pix' | 'nfe' | 'ai';

const u = t.agentsUi.flows;

/**
 * "Preencher a partir de" (spec 010): boleto (linha digitável, lida no
 * navegador), PIX copia-e-cola (pré-visualização local + busca da entidade na
 * API), NF-e (upload do XML) e documento lido por IA (PDF/imagem, fase 4).
 */
export function EntrySources({
  direction,
  allowNfe,
  initial,
  onApply,
}: {
  direction: 'payable' | 'receivable';
  allowNfe: boolean;
  initial?: { boletoBarcode?: string | null; pixPayload?: string | null };
  onApply: (patch: EntryPatch) => void;
}) {
  const [source, setSource] = useState<Source | null>(initial?.boletoBarcode ? 'boleto' : initial?.pixPayload ? 'pix' : null);
  const sources: Source[] = allowNfe ? ['boleto', 'pix', 'nfe', 'ai'] : ['boleto', 'pix', 'ai'];
  const icons: Record<Source, ReactNode> = { boleto: <Barcode />, pix: <ScanText />, nfe: <FileCode2 />, ai: <Sparkles /> };

  return (
    <div className="entry-box span-all">
      <div className="entry-head">
        <span className="label !mb-0">{t.entry.fillFrom}</span>
        <div className="segmented" role="group" aria-label={t.entry.fillFrom}>
          {sources.map((key) => (
            <button
              key={key}
              type="button"
              className={source === key ? 'active' : ''}
              aria-pressed={source === key}
              onClick={() => setSource(source === key ? null : key)}
            >
              {icons[key]} {key === 'ai' ? u.documentSource : t.entry.sources[key]}
            </button>
          ))}
        </div>
      </div>
      {source && (
        <div className="entry-body">
          {source === 'boleto' && <BoletoSource initial={initial?.boletoBarcode ?? ''} onApply={onApply} />}
          {source === 'pix' && <PixSource initial={initial?.pixPayload ?? ''} onApply={onApply} />}
          {source === 'nfe' && <NfeSource direction={direction} onApply={onApply} />}
          {source === 'ai' && <DocumentSource onApply={onApply} />}
        </div>
      )}
    </div>
  );
}

function initialBarcode(text: string): string | null {
  if (!text) return null;
  const parsed = parseBoleto(text);
  return parsed.ok ? parsed.barcode : null;
}

function BoletoSource({ initial, onApply }: { initial: string; onApply: (patch: EntryPatch) => void }) {
  const [text, setText] = useState(initial);
  const parsed = useMemo(() => (text.replace(/\D/g, '').length >= 44 ? parseBoleto(text) : null), [text]);
  const applied = useRef<string | null>(initialBarcode(initial));

  useEffect(() => {
    if (!parsed?.ok) {
      if (text.trim() === '' && applied.current !== null) {
        applied.current = null;
        onApply({ boletoBarcode: null });
      }
      return;
    }
    if (applied.current === parsed.barcode) return;
    applied.current = parsed.barcode;
    onApply({
      boletoBarcode: parsed.barcode,
      ...(parsed.amountCents ? { amountCents: parsed.amountCents } : {}),
      ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {}),
    });
  }, [parsed, text, onApply]);

  return (
    <>
      <Field label={t.entry.boletoInput}>
        <input
          className="field field-mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t.entry.boletoPlaceholder}
          inputMode="numeric"
          autoComplete="off"
        />
      </Field>
      {parsed && !parsed.ok && <p className="notice danger mt-2">{`${t.errors.boletoInvalid} ${parsed.error}`.trim()}</p>}
      {parsed?.ok && (
        <>
          <dl className="entry-preview">
            <dt>{t.common.kind}</dt>
            <dd>{t.entry.boletoKinds[parsed.kind]}</dd>
            {parsed.bankCode && (
              <>
                <dt>{t.entry.bank}</dt>
                <dd className="mono">{parsed.bankCode}</dd>
              </>
            )}
            <dt>{t.entry.line}</dt>
            <dd className="code-line">{parsed.digitableLine}</dd>
            <dt>{t.title.amount}</dt>
            <dd className="mono">{parsed.amountCents ? formatAccounting(parsed.amountCents) : '—'}</dd>
            <dt>{t.title.due}</dt>
            <dd className="mono">{parsed.dueDate ? formatDate(parsed.dueDate) : '—'}</dd>
          </dl>
          <p className="mt-2 text-[12px] text-muted">
            {t.entry.applied}
            {!parsed.amountCents && ` ${t.entry.noAmount}`}
            {!parsed.dueDate && ` ${t.entry.noDue}`}
          </p>
        </>
      )}
    </>
  );
}

function PixSource({ initial, onApply }: { initial: string; onApply: (patch: EntryPatch) => void }) {
  const [text, setText] = useState(initial);
  const payload = useDebounced(text.trim(), 300);
  const parsed = useMemo(() => (payload ? parseBrCode(payload) : null), [payload]);
  const [lookup, setLookup] = useState<PixEntryResult | null>(null);
  const [searching, setSearching] = useState(false);
  const applied = useRef<string | null>(initial || null);
  const { run, busy } = useAction();

  useEffect(() => {
    if (!parsed?.ok) {
      setLookup(null);
      if (!payload && applied.current) {
        applied.current = null;
        onApply({ pixPayload: null });
      }
      return;
    }
    if (applied.current === parsed.payload) return;
    let cancelled = false;
    setSearching(true);
    api
      .post<PixEntryResult>('/api/title-entry/pix', { payload: parsed.payload, createEntity: false })
      .then((result) => {
        if (cancelled) return;
        applied.current = parsed.payload;
        setLookup(result);
        onApply({
          pixPayload: parsed.payload,
          ...(result.entity ? { entity: { id: result.entity.id, name: result.entity.name, document: result.entity.document } } : {}),
          ...(result.amountCents ? { amountCents: result.amountCents } : {}),
          ...(result.description || result.merchantName ? { description: result.description ?? `PIX ${result.merchantName}` } : {}),
        });
      })
      .catch(() => {
        if (!cancelled) setLookup(null);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parsed, payload, onApply]);

  async function createEntity() {
    if (!parsed?.ok) return;
    const result = await run(
      () => api.post<PixEntryResult>('/api/title-entry/pix', { payload: parsed.payload, createEntity: true }),
      (r) => (r.entity ? t.entry.pixCreated(r.entity.name) : t.entry.pixNotFound),
    );
    if (result?.entity) {
      setLookup(result);
      onApply({ entity: { id: result.entity.id, name: result.entity.name, document: result.entity.document } });
    }
  }

  return (
    <>
      <Field label={t.entry.pixInput}>
        <textarea
          className="field field-mono"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t.entry.pixPlaceholder}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {parsed && !parsed.ok && <p className="notice danger mt-2">{`${t.errors.pixInvalid} ${parsed.error}`.trim()}</p>}
      {parsed?.ok && (
        <>
          <dl className="entry-preview">
            {parsed.pixKey && (
              <>
                <dt>{t.entry.pixKey}</dt>
                <dd className="mono">{parsed.pixKey}</dd>
              </>
            )}
            {parsed.merchantName && (
              <>
                <dt>{t.entry.pixName}</dt>
                <dd>{parsed.merchantName}</dd>
              </>
            )}
            {parsed.merchantCity && (
              <>
                <dt>{t.entry.pixCity}</dt>
                <dd>{parsed.merchantCity}</dd>
              </>
            )}
            <dt>{t.title.amount}</dt>
            <dd className="mono">{parsed.amountCents ? formatAccounting(parsed.amountCents) : '—'}</dd>
            {parsed.txid && parsed.txid !== '***' && (
              <>
                <dt>{t.entry.pixTxid}</dt>
                <dd className="mono">{parsed.txid}</dd>
              </>
            )}
          </dl>
          {parsed.dynamic && <p className="mt-2 text-[12px] text-muted">{t.entry.pixDynamic}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
            {searching && <span className="text-muted">{t.entry.pixSearching}</span>}
            {!searching && lookup?.entity && (
              <Badge tone="ok">
                {lookup.createdEntity ? t.entry.pixCreated(lookup.entity.name) : t.entry.pixFound(lookup.entity.name)}
              </Badge>
            )}
            {!searching && lookup && !lookup.entity && (
              <>
                <span className="text-muted">{t.entry.pixNotFound}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void createEntity()}>
                  <UserPlus /> {t.entry.pixCreate}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

function NfeSource({ direction, onApply }: { direction: 'payable' | 'receivable'; onApply: (patch: EntryPatch) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [nfe, setNfe] = useState<NfeEntryResult | null>(null);
  const [installed, setInstalled] = useState(false);
  const [reading, setReading] = useState(false);
  const { run } = useAction();

  async function read(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) return;
    setReading(true);
    const result = await run(
      () => upload<NfeEntryResult>('/api/title-entry/nfe', file),
      (r) => t.entry.nfeLoaded(r.number),
    );
    setReading(false);
    if (!result) return;
    setNfe(result);
    setInstalled(false);
    // A pagar: quem cobra é o emitente. A receber: o destinatário (se cadastrado), senão o emitente.
    const counterpart =
      direction === 'receivable' && result.recipient?.entityId
        ? { id: result.recipient.entityId, name: result.recipient.name ?? '', document: result.recipient.document }
        : { id: result.issuer.entityId, name: result.issuer.name, document: result.issuer.document };
    const firstDue = result.duplicates.find((d) => d.dueDate)?.dueDate;
    onApply({
      nfeDocumentId: result.nfeDocumentId,
      entity: counterpart,
      amountCents: result.totalCents,
      competenceDate: result.issuedAt.slice(0, 10),
      ...(firstDue ? { dueDate: firstDue } : {}),
      description: t.entry.nfeDescription(result.number),
    });
  }

  const dups = nfe?.duplicates ?? [];
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xml,text/xml,application/xml"
        hidden
        aria-label={t.entry.nfeInput}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void read(file);
          event.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={reading} onClick={() => input.current?.click()}>
          <FileCode2 /> {reading ? t.entry.nfeReading : t.entry.nfePick}
        </Button>
        {nfe && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setNfe(null);
              onApply({ nfeDocumentId: null });
            }}
          >
            <X /> {t.entry.unlink}
          </Button>
        )}
      </div>
      {nfe && (
        <>
          {nfe.alreadyImported && <p className="notice info mt-2">{t.entry.nfeAlready}</p>}
          <dl className="entry-preview">
            <dt>{t.entry.nfeNumber}</dt>
            <dd className="mono">{t.entry.nfeNumberSeries(nfe.number, nfe.series)}</dd>
            <dt>{t.entry.nfeIssuer}</dt>
            <dd>
              {nfe.issuer.name} <span className="mono text-faint">{formatDocument(nfe.issuer.document)}</span>
              {nfe.issuer.created && (
                <Badge tone="info" className="ml-2">
                  {t.entry.nfeIssuerCreated}
                </Badge>
              )}
            </dd>
            <dt>{t.entry.nfeIssued}</dt>
            <dd className="mono">{formatDate(nfe.issuedAt.slice(0, 10))}</dd>
            <dt>{t.entry.nfeTotal}</dt>
            <dd className="mono">{formatAccounting(nfe.totalCents)}</dd>
            {dups.length > 0 && (
              <>
                <dt>{t.entry.nfeDuplicates(dups.length)}</dt>
                <dd className="mono">
                  {dups.map((d, i) => (
                    <span key={`${d.number}-${i}`} className="block">
                      {d.number ?? i + 1} · {d.dueDate ? formatDate(d.dueDate) : '—'} · {formatAccounting(d.amountCents)}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
          {dups.length >= 2 && (
            <div className={cx('notice mt-2', installed ? 'info' : 'warn')}>
              <p>{installed ? t.entry.nfeInstallApplied(dups.length) : t.entry.nfeInstallOffer(dups.length)}</p>
              <p className="mt-1 text-[12px]">{t.entry.nfeInstallWarn}</p>
              {!installed && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => {
                    setInstalled(true);
                    onApply({ installments: { count: dups.length, amountCents: dups[0]!.amountCents } });
                  }}
                >
                  {t.entry.nfeInstallApply(dups.length)}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** PDF/imagem lido por IA (POST /api/title-entry/document): pode levar até ~90 s; 501 = sem agente configurado. */
function DocumentSource({ onApply }: { onApply: (patch: EntryPatch) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentReadingDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) return setError(t.agentsUi.chat.attachmentTooLarge);
    setReading(file.name);
    setError(null);
    setResult(null);
    try {
      const doc = await upload<DocumentReadingDto>('/api/title-entry/document', file);
      setResult(doc);
      const boleto = doc.boletoLine ? parseBoleto(doc.boletoLine) : null;
      onApply({
        ...(doc.entityId ? { entity: { id: doc.entityId, name: doc.entityName ?? '', document: doc.document ?? null } } : {}),
        ...(doc.amountCents ? { amountCents: doc.amountCents } : {}),
        ...(doc.dueDate ? { dueDate: doc.dueDate } : {}),
        ...(doc.description ? { description: doc.description } : {}),
        ...(boleto?.ok ? { boletoBarcode: boleto.barcode } : {}),
        ...(doc.pixPayload ? { pixPayload: doc.pixPayload } : {}),
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 501 || err.code === 'document_reader_unavailable')) setError(u.documentUnavailable);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(null);
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        hidden
        aria-label={u.documentPick}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void read(file);
          event.target.value = '';
        }}
      />
      <p className="mb-2 text-[12px] text-muted">{u.documentHint}</p>
      <Button size="sm" variant="ghost" disabled={reading !== null} onClick={() => input.current?.click()}>
        {reading ? <Loader2 className="spin" /> : <FileScan />} {reading ?? u.documentPick}
      </Button>
      {reading && <p className="notice info mt-2">{u.documentReading}</p>}
      {error && <p className="notice danger mt-2">{error}</p>}
      {result && (
        <>
          <dl className="entry-preview">
            <dt>{t.common.kind}</dt>
            <dd>{u.documentKinds[result.kind] ?? result.kind}</dd>
            {result.entityName && (
              <>
                <dt>{t.title.entity}</dt>
                <dd>
                  {result.entityName}
                  {result.document && <span className="mono text-faint"> {formatDocument(result.document)}</span>}
                </dd>
              </>
            )}
            <dt>{t.title.amount}</dt>
            <dd className="mono">{result.amountCents ? formatAccounting(result.amountCents) : '—'}</dd>
            <dt>{t.title.due}</dt>
            <dd className="mono">{result.dueDate ? formatDate(result.dueDate) : '—'}</dd>
            {result.description && (
              <>
                <dt>{t.common.description}</dt>
                <dd>{result.description}</dd>
              </>
            )}
            {result.boletoLine && (
              <>
                <dt>{t.entry.line}</dt>
                <dd className="code-line">{result.boletoLine}</dd>
              </>
            )}
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-muted">{u.documentRead}</span>
            {result.entityName &&
              (result.entityId ? (
                <Badge tone="ok">{u.entityFound(result.entityName)}</Badge>
              ) : (
                <span className="text-muted">{u.entityNotFound(result.entityName)}</span>
              ))}
          </div>
        </>
      )}
    </>
  );
}
