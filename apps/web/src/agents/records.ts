import { t } from '@moneyflow/shared';
import type { DragEvent } from 'react';

/*
 * Arrastar um registro (título, entidade, caixa…) para dentro de uma janela de
 * agente: o dataTransfer leva {kind,id,label} no tipo abaixo, e a janela
 * insere a referência "[título: Aluguel março](title:<id>)" no composer.
 */

export const RECORD_MIME = 'application/x-moneyflow-record';

export type RecordRef = { kind: string; id: string; label: string };

/** Props para tornar um elemento arrastável como registro. */
export function recordDragProps(record: RecordRef) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(RECORD_MIME, JSON.stringify(record));
      event.dataTransfer.setData('text/plain', recordMarkdown(record));
      event.dataTransfer.effectAllowed = 'copy';
    },
  };
}

export function hasRecord(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(RECORD_MIME);
}

export function readRecord(event: DragEvent<HTMLElement>): RecordRef | null {
  const raw = event.dataTransfer.getData(RECORD_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RecordRef>;
    if (typeof value.kind !== 'string' || typeof value.id !== 'string') return null;
    return { kind: value.kind, id: value.id, label: typeof value.label === 'string' ? value.label : value.id };
  } catch {
    return null;
  }
}

/** "[título: Aluguel março](title:<id>)" — o texto que vai na mensagem. */
export function recordMarkdown(record: RecordRef): string {
  const kind = t.agentsUi.chat.recordKinds[record.kind] ?? record.kind;
  const label = record.label.replace(/[[\]]/g, '').slice(0, 200);
  return `[${kind}: ${label}](${record.kind}:${record.id})`;
}
