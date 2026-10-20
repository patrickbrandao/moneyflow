import { formatAccounting, type MirrorStatus, type TitleRow, t } from '@moneyflow/shared';
import { AlertCircle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ApiError } from '../lib/api';
import { Badge, Button, cx, EmptyState, Skel } from './ui';

/* Peças visuais do domínio, reaproveitadas pelas telas. */

/** Cor da categoria: o slot 1–12 vira o token --port-N (nunca hex). */
export function CategoryDot({ slot }: { slot: number | null | undefined }) {
  return <span className="cat-dot" style={slot ? { background: `var(--port-${slot})` } : undefined} aria-hidden />;
}

export function CategoryLabel({ name, slot }: { name: string; slot: number | null | undefined }) {
  return (
    <span className="cat-label">
      <CategoryDot slot={slot} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Classe do valor negativo (vermelho escuro do formato contábil) para quem escreve o `.money` à mão. */
export const negClass = (cents: number | null | undefined) => ((cents ?? 0) < 0 ? 'neg' : undefined);

/**
 * Valor em BRL no formato contábil: negativo entre parênteses, sem sinal, em vermelho escuro.
 * `signed`: o positivo (entrando) fica verde.
 */
export function Money({ cents, signed, muted, className }: { cents: number; signed?: boolean; muted?: boolean; className?: string }) {
  const tone = cents < 0 ? 'neg' : muted ? 'muted' : signed && cents > 0 ? 'in' : '';
  return <span className={cx('money', tone, className)}>{formatAccounting(cents)}</span>;
}

export function TitleStatusBadge({ title }: { title: Pick<TitleRow, 'status' | 'overdue' | 'direction'> }) {
  if (title.status === 'canceled') return <Badge tone="outline">{t.title.statuses.canceled}</Badge>;
  if (title.status === 'paid')
    return <Badge tone="ok">{title.direction === 'receivable' ? t.title.receivedStatus.paid : t.title.statuses.paid}</Badge>;
  if (title.overdue) return <Badge tone="danger">{t.title.statuses.overdue}</Badge>;
  if (title.status === 'partial') return <Badge tone="info">{t.title.statuses.partial}</Badge>;
  return <Badge>{t.title.statuses.open}</Badge>;
}

export function MirrorBadge({ status }: { status: MirrorStatus | null }) {
  if (!status) return null;
  const tone = status === 'pending' ? 'warn' : status === 'disputed' ? 'danger' : 'info';
  return <Badge tone={tone}>{t.title.mirrorStatuses[status]}</Badge>;
}

export function RoleBadge({ role }: { role: string }) {
  return <Badge tone={role === 'admin' ? 'accent' : role === 'editor' ? 'info' : 'neutral'}>{t.roles[role] ?? role}</Badge>;
}

/** Erro de carga desenhado, com "tentar de novo". */
export function LoadError({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<AlertCircle />}
      title={t.common.loadError}
      description={error.message}
      action={
        onRetry && (
          <Button variant="ghost" onClick={onRetry}>
            <RotateCw /> {t.common.retry}
          </Button>
        )
      }
    />
  );
}

/** Linhas-esqueleto de uma tabela que está carregando. */
export function SkelRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          <td colSpan={cols}>
            <Skel h={18} />
          </td>
        </tr>
      ))}
    </>
  );
}

/** Cabeçalho de página padrão (.page-head). */
export function PageHead({
  title,
  sub,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="min-w-0">
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
