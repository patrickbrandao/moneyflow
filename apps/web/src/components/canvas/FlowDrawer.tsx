import { entityLink, type FlowLineDto, formatAccounting, formatDate, t } from '@moneyflow/shared';
import { ArrowRight, Building2, CreditCard, Crosshair, ExternalLink, Layers, Ungroup, UserRound, Wallet, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { CategoryDot, LoadError, negClass } from '../domain';
import { Badge, Button, ButtonLink, cx, Skel } from '../ui';
import { EDGE_COLOR, type EndRef, type FlowNode, type MoneyEdge } from './graph';

/*
 * A gaveta do palco: o nó ou a aresta selecionada e os lançamentos dela
 * (flow_graph_lines), cada um com o link para o registro de origem.
 */

export type FlowSelection = { type: 'node'; node: FlowNode } | { type: 'edge'; edge: MoneyEdge; sourceName: string; targetName: string };

const LINES_LIMIT = 300;

function endParams(prefix: 'source' | 'target', end: EndRef, params: URLSearchParams) {
  if (end.kind === 'cluster') params.set('entityIds', end.entityIds.join(','));
  else {
    params.set(`${prefix}Kind`, end.kind);
    params.set(`${prefix}Id`, end.id);
  }
}

/** Caminho da API com as linhas da seleção. */
function linesPath(selection: FlowSelection, base: { from: string; to: string; caixaIds: string[] }) {
  const params = new URLSearchParams({ from: base.from, to: base.to, limit: String(LINES_LIMIT) });
  if (base.caixaIds.length) params.set('caixaIds', base.caixaIds.join(','));
  if (selection.type === 'node') {
    const node = selection.node;
    if (node.type === 'cluster') params.set('entityIds', node.data.entityIds.join(','));
    else {
      params.set('nodeKind', node.type === 'caixa' ? 'caixa' : 'entity');
      params.set('nodeId', node.data.ref.id);
    }
  } else {
    const data = selection.edge.data!;
    params.set('edgeKind', data.kind);
    endParams('source', data.source, params);
    endParams('target', data.target, params);
  }
  return `/api/flow/lines?${params}`;
}

export function FlowDrawer({
  selection,
  base,
  onClose,
  onFocus,
  onExpand,
}: {
  selection: FlowSelection | null;
  base: { from: string; to: string; caixaIds: string[] };
  onClose: () => void;
  onFocus: (nodeId: string) => void;
  onExpand: (groupId: string) => void;
}) {
  const lines = useApi<FlowLineDto[]>(selection ? linesPath(selection, base) : null);
  if (!selection) return null;

  const head = (icon: ReactNode, title: string) => (
    <div className="dh">
      {icon}
      <span className="t">{title}</span>
      <button type="button" className="icon-btn" onClick={onClose} title={`${t.common.close} (Esc)`} aria-label={t.common.close}>
        <X />
      </button>
    </div>
  );

  let header: ReactNode;
  let body: ReactNode;
  if (selection.type === 'edge') {
    const data = selection.edge.data!;
    header = head(<span className="flow-kind-dot" style={{ background: EDGE_COLOR[data.kind] }} />, t.flow.edgeKinds[data.kind]!);
    body = (
      <div className="sec">
        <p className="flow-route">
          <span className="truncate">{selection.sourceName}</span>
          <ArrowRight />
          <span className="truncate">{selection.targetName}</span>
        </p>
        <dl className="kv mt-3">
          <dt>{t.flow.realized}</dt>
          <dd className={cx('money', negClass(data.realizedCents))}>{formatAccounting(data.realizedCents)}</dd>
          <dt>{t.flow.forecast}</dt>
          <dd className={cx('money', negClass(data.forecastCents))}>{formatAccounting(data.forecastCents)}</dd>
          <dt>{t.flow.lines}</dt>
          <dd>{data.lines}</dd>
        </dl>
      </div>
    );
  } else {
    const node = selection.node;
    if (node.type === 'caixa') {
      const ref = node.data.ref;
      header = head(node.data.isCard ? <CreditCard size={18} /> : <Wallet size={18} />, node.data.name);
      body = (
        <div className="sec">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="accent">{node.data.isCard ? t.flow.cardNode : t.flow.caixaNode}</Badge>
          </div>
          <dl className="kv mt-3">
            {node.data.isCard ? (
              <>
                <dt>{t.flow.cardUsed}</dt>
                <dd className={cx('money', negClass(ref.cardUsedCents ?? 0))}>{formatAccounting(ref.cardUsedCents ?? 0)}</dd>
                <dt>{t.flow.cardLimit}</dt>
                <dd className={cx('money', negClass(ref.cardLimitCents ?? 0))}>{formatAccounting(ref.cardLimitCents ?? 0)}</dd>
              </>
            ) : (
              <>
                <dt>{t.flow.balance}</dt>
                <dd className={cx('money', negClass(ref.balanceCents ?? 0))}>{formatAccounting(ref.balanceCents ?? 0)}</dd>
              </>
            )}
            <dt>{t.flow.inflow}</dt>
            <dd className={cx('money', negClass(ref.realizedInCents))}>{formatAccounting(ref.realizedInCents)}</dd>
            <dt>{t.flow.outflow}</dt>
            <dd className={cx('money', negClass(ref.realizedOutCents))}>{formatAccounting(ref.realizedOutCents)}</dd>
            <dt>{t.flow.forecastIn}</dt>
            <dd className={cx('money', negClass(ref.forecastInCents))}>{formatAccounting(ref.forecastInCents)}</dd>
            <dt>{t.flow.forecastOut}</dt>
            <dd className={cx('money', negClass(ref.forecastOutCents))}>{formatAccounting(ref.forecastOutCents)}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink to={`/caixas/${ref.id}`} size="sm">
              <ExternalLink /> {t.flow.openCaixa}
            </ButtonLink>
            <Button variant="ghost" size="sm" onClick={() => onFocus(node.id)}>
              <Crosshair /> {t.flow.center}
            </Button>
          </div>
        </div>
      );
    } else if (node.type === 'entity') {
      const ref = node.data.ref;
      header = head(ref.entityKind === 'company' ? <Building2 size={18} /> : <UserRound size={18} />, node.data.name);
      body = (
        <div className="sec">
          {node.data.groupName && (
            <div className="flex flex-wrap gap-1.5">
              <Badge>{node.data.groupName}</Badge>
            </div>
          )}
          <dl className="kv mt-3">
            <dt>{t.flow.inflow}</dt>
            <dd className={cx('money', negClass(ref.realizedInCents))}>{formatAccounting(ref.realizedInCents)}</dd>
            <dt>{t.flow.outflow}</dt>
            <dd className={cx('money', negClass(ref.realizedOutCents))}>{formatAccounting(ref.realizedOutCents)}</dd>
            <dt>{t.flow.forecastIn}</dt>
            <dd className={cx('money', negClass(ref.forecastInCents))}>{formatAccounting(ref.forecastInCents)}</dd>
            <dt>{t.flow.forecastOut}</dt>
            <dd className={cx('money', negClass(ref.forecastOutCents))}>{formatAccounting(ref.forecastOutCents)}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink to={entityLink(ref.id)} size="sm">
              <ExternalLink /> {t.flow.openEntity}
            </ButtonLink>
            <Button variant="ghost" size="sm" onClick={() => onFocus(node.id)}>
              <Crosshair /> {t.flow.center}
            </Button>
          </div>
        </div>
      );
    } else {
      header = head(<Layers size={18} />, t.flow.groupOf(node.data.name || t.flow.otherGroup));
      body = (
        <div className="sec">
          <p className="text-[13px] text-dim">
            {node.data.entityNames.map((name, index) => {
              const hit = node.data.matchedNames?.includes(name);
              return (
                <span key={name}>
                  {index > 0 && ', '}
                  <span className={hit ? 'font-medium text-ink' : undefined} title={hit ? t.entityTags.matchesFilter : undefined}>
                    {hit && '● '}
                    {name}
                  </span>
                </span>
              );
            })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onExpand(node.data.groupId)}>
              <Ungroup /> {t.flow.expand}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onFocus(node.id)}>
              <Crosshair /> {t.flow.center}
            </Button>
          </div>
        </div>
      );
    }
  }

  return (
    <aside className="drawer" aria-label={t.flow.lines}>
      {header}
      <div className="db">
        {body}
        <div className="sec">
          <p className="eyebrow">{t.flow.lines}</p>
          {lines.error ? (
            <LoadError error={lines.error} onRetry={() => void lines.reload()} />
          ) : !lines.data ? (
            <div className="grid gap-2">
              <Skel h={40} />
              <Skel h={40} />
              <Skel h={40} />
            </div>
          ) : lines.data.length === 0 ? (
            <p className="text-[13px] text-faint">{t.flow.linesEmpty}</p>
          ) : (
            <ul className="flow-lines">
              {lines.data.map((line) => (
                <FlowLine key={`${line.refKind}:${line.refId}:${line.sourceId}:${line.targetId}`} line={line} />
              ))}
            </ul>
          )}
          {lines.data && lines.data.length >= LINES_LIMIT && <p className="hint">{t.flow.linesMore(LINES_LIMIT)}</p>}
        </div>
      </div>
    </aside>
  );
}

function FlowLine({ line }: { line: FlowLineDto }) {
  const forecast = line.realizedCents === 0 && line.forecastCents !== 0;
  const content = (
    <>
      <span className="fl-main">
        <span className="fl-desc">{line.description || t.flow.edgeKinds[line.edgeKind]}</span>
        <span className="fl-sub">
          <span className="mono">{formatDate(line.occurredOn)}</span>
          {line.categoryName && (
            <>
              {' · '}
              <CategoryDot slot={line.colorSlot} /> {line.categoryName}
            </>
          )}
          {' · '}
          {line.sourceName} → {line.targetName}
        </span>
      </span>
      <span className="fl-val">
        <span className={cx('money', negClass(forecast ? line.forecastCents : line.realizedCents))}>
          {formatAccounting(forecast ? line.forecastCents : line.realizedCents)}
        </span>
        {forecast && <Badge tone="outline">{t.flow.forecast.toLowerCase()}</Badge>}
      </span>
    </>
  );
  return <li>{line.link ? <Link to={line.link}>{content}</Link> : <div>{content}</div>}</li>;
}
