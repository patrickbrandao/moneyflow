import { type AttachmentBlock, t } from '@moneyflow/shared';
import type { LlmAttachment } from './types';

/** Rótulo de um anexo para o modelo: nome, tipo e o id que as tools de importação recebem (spec 027). */
export function attachmentLabel(block: AttachmentBlock, file: LlmAttachment | null): string {
  return t.agents.attachments.label(
    file?.fileName ?? block.file_name ?? 'arquivo',
    file?.mime ?? block.mime_type ?? '?',
    block.attachment_id,
  );
}
