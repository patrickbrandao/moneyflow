import { type ConversationDetail, type ConversationDto, t } from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { ModalActions } from '../components/forms';
import { Button, Field, Modal, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { conversationMeta, useAgents } from './AgentsProvider';

const u = t.agentsUi;

type Target = Pick<ConversationDto, 'id' | 'title' | 'pinnedAt' | 'archivedAt'>;

/**
 * Ações de uma conversa (lista do ícone e cabeçalho da janela): renomear,
 * fixar, arquivar, excluir e bifurcar a partir da última mensagem.
 * Devolve também o modal de renomear, para quem usa renderizar.
 */
export function useConversationActions(onChanged?: (conversation: ConversationDto | null) => void) {
  const agents = useAgents();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [renaming, setRenaming] = useState<Target | null>(null);
  const [title, setTitle] = useState('');

  const changed = (conversation: ConversationDto | null) => {
    agents.bumpList();
    if (conversation) agents.updateMeta({ id: conversation.id, title: conversation.title });
    onChanged?.(conversation);
  };

  async function patch(target: Target, body: { title?: string; pinned?: boolean; archived?: boolean }, success?: string) {
    const result = await run(() => api.patch<ConversationDto>(`/api/conversations/${target.id}`, body), success);
    if (result) changed(result);
    return result;
  }

  const actions = {
    rename(target: Target) {
      setTitle(target.title ?? '');
      setRenaming(target);
    },
    togglePin: (target: Target) => patch(target, { pinned: !target.pinnedAt }),
    toggleArchive: (target: Target) => {
      if (!target.archivedAt) agents.close(target.id);
      return patch(target, { archived: !target.archivedAt });
    },
    async remove(target: Target) {
      const name = target.title ?? u.list.untitled;
      const ok = await confirm({
        title: u.actions.deleteConfirm(name),
        description: u.actions.deleteDescription,
        confirmLabel: t.common.delete,
        danger: true,
      });
      if (!ok) return;
      const result = await run(() => api.del(`/api/conversations/${target.id}`), u.actions.deleted);
      if (result) {
        agents.close(target.id);
        changed(null);
      }
    },
    async fork(target: Pick<ConversationDto, 'id'>) {
      const created = await run(async () => {
        const detail = await api.get<ConversationDetail>(`/api/conversations/${target.id}`);
        const last = detail.messages[detail.messages.length - 1];
        if (!last) throw new Error(u.actions.forkEmpty);
        return api.post<ConversationDto>(`/api/conversations/${target.id}/fork`, { messageId: last.id });
      }, u.actions.forked);
      if (created) {
        agents.open(conversationMeta(created));
        changed(created);
      }
    },
  };

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || !title.trim()) return;
    const result = await patch(renaming, { title: title.trim() }, u.actions.renamed);
    if (result) setRenaming(null);
  }

  const modal = (
    <Modal open={renaming !== null} title={u.actions.renameTitle} onClose={() => setRenaming(null)}>
      <form onSubmit={submitRename} className="form-grid">
        <Field label={u.actions.titleLabel}>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </Field>
        <ModalActions>
          <Button variant="ghost" onClick={() => setRenaming(null)}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );

  return { actions, modal, busy };
}
