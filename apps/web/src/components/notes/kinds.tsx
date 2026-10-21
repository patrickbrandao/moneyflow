import { NOTE_KIND_ORDER, type NoteBadge, type NoteKind, type NoteKindCounts, t } from '@moneyflow/shared';
import { cx } from '../ui';

/* Cor e nome dos tipos de anotação (spec 035): sempre pelo token --note-<tipo>. */

export const noteColor = (kind: NoteKind) => `var(--note-${kind})`;

export function NoteKindDot({ kind, size, className }: { kind: NoteKind; size?: 'lg'; className?: string }) {
  return <span className={cx('note-dot', size === 'lg' && 'lg', className)} style={{ background: noteColor(kind) }} aria-hidden />;
}

/** "2 nota grave, 1 lembrete" na ordem de exibição dos tipos. */
export function countsText(counts: NoteKindCounts): string {
  return NOTE_KIND_ORDER.filter((kind) => (counts[kind] ?? 0) > 0)
    .map((kind) => t.notes.ui.countOf(counts[kind] ?? 0, t.notes.kinds[kind] ?? kind))
    .join(', ');
}

/** Selo da entidade na listagem: a bolinha do tipo mais grave, com as contagens no tooltip. */
export function NoteBadgeDot({ badge }: { badge: NoteBadge | null | undefined }) {
  if (!badge) return null;
  const label = t.notes.ui.badge(countsText(badge.counts));
  return (
    <span className="note-badge" title={label} role="img" aria-label={label} data-note-badge={badge.kind}>
      <NoteKindDot kind={badge.kind} />
    </span>
  );
}

export function NoteKindLabel({ kind }: { kind: NoteKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <NoteKindDot kind={kind} />
      {t.notes.kinds[kind]}
    </span>
  );
}
