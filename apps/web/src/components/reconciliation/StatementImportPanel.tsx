import { type CardOverview, formatDate, formatDateTime, type StatementImportSummary, type StatementLineRow, t } from '@moneyflow/shared';
import { Download, FileUp, Search, Trash2, X } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { useParamState, useSetParams } from '../../lib/params';
import { attachmentUrl } from '../../lib/upload';
import { LoadError, Money, SkelRows } from '../domain';
import { useToast } from '../Toast';
import { Badge, Button, cx, EmptyRow, useConfirm, useDebounced } from '../ui';
import { BalanceCompare, ImportDetail, LineStatusBadge, type SuggestionRun } from './ImportDetail';
import { ImportModal, type StatementTarget } from './ImportModal';
import { LineActions, LineClassification, LinePair } from './LineActions';
import '../../styles/reconciliation.css';

const s = t.statements;

/** Import de extrato/fatura e conciliação de uma conta ou cartão (spec 009). */
export function StatementImportPanel({
  caixaId,
  accountId,
  cardCaixaId,
  canWrite,
  onChanged,
}: {
  caixaId: string;
  accountId?: string | null;
  cardCaixaId?: string | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const target: StatementTarget | null = accountId ? { accountId } : cardCaixaId ? { cardCaixaId } : null;
  const query = accountId ? `accountId=${accountId}` : `cardCaixaId=${cardCaixaId}`;
  const imports = useApi<StatementImportSummary[]>(target ? `/api/statement-imports?${query}` : null);
  const card = useApi<CardOverview>(cardCaixaId ? `/api/cards/${cardCaixaId}` : null);
  const [importId, setImportId] = useParamState('import');
  const setParams = useSetParams();
  const [importing, setImporting] = useState<{ file: File | null } | null>(null);
  const toast = useToast();
  // A sugestão do agente enfileirada pelo import que acabou de abrir (só para esse lote).
  const [suggestion, setSuggestion] = useState<(SuggestionRun & { importId: string }) | null>(null);
  const [over, setOver] = useState(false);
  const confirm = useConfirm();
  const { run } = useAction();
  const isCard = Boolean(cardCaixaId);
  const label = isCard ? s.importInvoice : s.importStatement;
  // Busca por descrição nas linhas: em todos os lotes da conta ou nos marcados na lista (spec 009).
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [scope, setScope] = useState<Set<string>>(new Set());
  const scopeIds = [...scope].filter((id) => imports.data?.some((row) => row.id === id));
  const found = useApi<StatementLineRow[]>(
    target && term.length >= 2
      ? `/api/statement-lines?${query}&q=${encodeURIComponent(term)}${scopeIds.length ? `&importIds=${scopeIds.join(',')}` : ''}`
      : null,
  );

  useRegisterCommands(
    canWrite && target
      ? [{ id: 'statement-import', label, group: 'Criar', icon: <FileUp />, run: () => setImporting({ file: null }) }]
      : [],
    [canWrite, accountId, cardCaixaId],
  );

  const changed = () => {
    void imports.reload();
    if (term.length >= 2) void found.reload();
    onChanged();
  };

  const toggleScope = (id: string) =>
    setScope((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allScoped = Boolean(imports.data?.length) && imports.data!.every((row) => scope.has(row.id));
  const fileOf = new Map((imports.data ?? []).map((row) => [row.id, row]));

  async function remove(row: StatementImportSummary) {
    const ok = await confirm({
      title: s.deleteImportTitle(row.fileName),
      description: s.deleteImportBody,
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (ok && (await run(() => api.del(`/api/statement-imports/${row.id}`), s.importDeleted))) changed();
  }

  if (!target) return null;

  if (importId) {
    return (
      <ImportDetail
        key={importId}
        importId={importId}
        caixaId={caixaId}
        card={card.data ?? null}
        onBack={() => setParams({ import: null, lines: null })}
        onChanged={changed}
        suggestionRun={suggestion?.importId === importId ? suggestion : null}
      />
    );
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && canWrite) setImporting({ file });
  };

  return (
    <div
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="rec-bar">
        <h2 className="text-h3 !mb-0">{s.imports}</h2>
        <span className="flex-1" />
        <label className="search-bar">
          <Search />
          <input
            className="field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={s.searchPlaceholder}
            aria-label={s.search}
            data-testid="line-search"
          />
        </label>
        {q && (
          <Button variant="quiet" size="sm" onClick={() => setQ('')} title={s.searchClear} aria-label={s.searchClear}>
            <X />
          </Button>
        )}
        {canWrite && (
          <Button onClick={() => setImporting({ file: null })}>
            <FileUp /> {label}
          </Button>
        )}
      </div>

      {term.length >= 2 && (
        <section className="mb-4" data-testid="line-search-results">
          <p className="mb-2 text-[13px] text-muted">
            {found.data
              ? found.data.length === 0
                ? s.searchNone
                : s.searchResults(found.data.length, found.data.length >= 200)
              : t.common.loading}{' '}
            · {scopeIds.length ? s.searchScopeSelected(scopeIds.length) : s.searchScopeAll}
          </p>
          {found.error ? (
            <LoadError error={found.error} onRetry={() => void found.reload()} />
          ) : (
            found.data?.length !== 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.common.date}</th>
                      <th>{t.common.description}</th>
                      <th className="num">{t.common.amount}</th>
                      <th>{t.common.status}</th>
                      <th>{s.importColumn}</th>
                      <th>{s.pair}</th>
                      <th>{s.classification}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {!found.data && <SkelRows cols={8} />}
                    {found.data?.map((line) => {
                      const imp = fileOf.get(line.importId);
                      return (
                        <tr key={line.id} className={cx(line.status === 'ignored' && 'is-off')}>
                          <td className="mono whitespace-nowrap text-xs">{formatDate(line.postedOn)}</td>
                          <td className="rec-wide">
                            <span className="row-title">{line.description}</span>
                            {line.fitid && <span className="row-sub mono">{line.fitid}</span>}
                          </td>
                          <td className="num whitespace-nowrap">
                            <Money cents={line.amountCents} signed />
                          </td>
                          <td>
                            <LineStatusBadge status={line.status} />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="link text-left text-[13px]"
                              title={imp ? `${formatDate(imp.periodStart)} – ${formatDate(imp.periodEnd)}` : undefined}
                              onClick={() => setImportId(line.importId)}
                            >
                              {imp?.fileName ?? s.importColumn}
                            </button>
                          </td>
                          <td className="rec-wide">
                            <LinePair line={line} />
                          </td>
                          <td className="rec-mid">
                            <LineClassification line={line} />
                          </td>
                          <td className="text-right">
                            {canWrite && (
                              <LineActions line={line} isCard={isCard} caixaId={caixaId} card={card.data ?? null} onChanged={changed} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
      )}

      {imports.error ? (
        <LoadError error={imports.error} onRetry={() => void imports.reload()} />
      ) : (
        <div className={cx('table-wrap', over && 'rec-over')}>
          <table className="data">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label={s.selectAllImports}
                    title={s.selectAllImports}
                    checked={allScoped}
                    disabled={!imports.data?.length}
                    onChange={() => setScope(allScoped ? new Set() : new Set(imports.data?.map((row) => row.id)))}
                  />
                </th>
                <th>{s.file}</th>
                <th>{s.period}</th>
                <th className="num">{s.lines}</th>
                <th>{t.common.status}</th>
                <th>
                  {s.bankBalance} × {s.appBalance.toLowerCase()}
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!imports.data && <SkelRows cols={7} />}
              {imports.data?.length === 0 && <EmptyRow colSpan={7}>{isCard ? s.noImportsCard : s.noImports}</EmptyRow>}
              {imports.data?.map((row) => (
                <tr key={row.id} className={cx('cursor-pointer', scope.has(row.id) && 'is-selected')} onClick={() => setImportId(row.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={s.selectImport(row.fileName)}
                      checked={scope.has(row.id)}
                      onChange={() => toggleScope(row.id)}
                    />
                  </td>
                  <td className="rec-wide">
                    <button
                      type="button"
                      className="row-title text-left hover:text-[var(--accent-soft)]"
                      onClick={() => setImportId(row.id)}
                    >
                      {row.fileName}
                    </button>
                    <span className="row-sub">
                      {row.format.toUpperCase()} · {s.importedAt(formatDateTime(row.createdAt), row.importedBy)}
                    </span>
                  </td>
                  <td className="mono whitespace-nowrap text-xs">
                    {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
                  </td>
                  <td className="num">{row.lineCount}</td>
                  <td>
                    <span className="inline-flex flex-wrap gap-1">
                      {row.matchedLines > 0 && <Badge tone="ok">{`${row.matchedLines} ${s.statuses.matched!.toLowerCase()}`}</Badge>}
                      {row.suggestedLines > 0 && (
                        <Badge tone="accent">{`${row.suggestedLines} ${s.statuses.suggested!.toLowerCase()}`}</Badge>
                      )}
                      {row.newLines > 0 && <Badge tone="warn">{`${row.newLines} ${s.statuses.new!.toLowerCase()}`}</Badge>}
                      {row.ignoredLines > 0 && <Badge tone="outline">{`${row.ignoredLines} ${s.statuses.ignored!.toLowerCase()}`}</Badge>}
                    </span>
                  </td>
                  <td>
                    <BalanceCompare bank={row.bankBalanceCents} app={row.appBalanceCents} diff={row.differenceCents} />
                  </td>
                  <td className="text-right">
                    <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <a className="row-action" href={attachmentUrl(row.attachmentId)} title={s.download} aria-label={s.download}>
                        <Download />
                      </a>
                      {canWrite && (
                        <button
                          type="button"
                          className="row-action danger"
                          title={s.deleteImport}
                          aria-label={s.deleteImport}
                          onClick={() => void remove(row)}
                        >
                          <Trash2 />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {importing && (
        <ImportModal
          target={target}
          card={card.data ?? null}
          initialFile={importing.file}
          onClose={() => setImporting(null)}
          onImported={(detail) => {
            setImporting(null);
            changed();
            const ai = detail.aiSuggestion;
            setSuggestion(ai?.queued && ai.runId ? { importId: detail.id, runId: ai.runId, lines: ai.lines } : null);
            // Sugestão pulada (spec 028): orçamento de IA atingido ou limite por minuto.
            if (ai?.skippedReason) toast.error(ai.skippedReason);
            setImportId(detail.id);
          }}
        />
      )}
    </div>
  );
}
