import { type ConversationDetail, type ConversationDto, t } from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { ModalActions } from '../components/forms';
import { useToast } from '../components/Toast';
import { Button, Field, Modal, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useAgents } from './AgentsProvider';

const u = t.agentsUi;

type Target = Pick<ConversationDto, 'id' | 'title'>;

/**
 * Ações de uma sessão (lista do ícone e cabeçalho da janela, spec 026):
 * renomear, copiar o id, excluir uma finalizada e "Bifurcar daqui" (a cópia
 * vira a sessão ativa do agente e abre na janela dele). Finalizar fica na
 * janela do agente (useConversation.finish), com a confirmação daqui.
 * Devolve também o modal de renomear, para quem usa renderizar.
 */
export function useConversationActions(onChanged?: (conversation: ConversationDto | null) => void) {
  const agents = useAgents();
  const confirm = useConfirm();
  const toast = useToast();
  const { run, busy } = useAction();
  const [renaming, setRenaming] = useState<Target | null>(null);
  const [title, setTitle] = useState('');

  const changed = (conversation: ConversationDto | null) => {
    agents.bumpList();
    if (conversation) {
      // A janela de leitura é chaveada pela sessão; a do agente, pelo agente.
      agents.updateMeta({ id: conversation.id, title: conversation.title });
      if (!conversation.archivedAt) agents.updateMeta({ id: conversation.agentId, title: conversation.title });
    }
    onChanged?.(conversation);
  };

  const actions = {
    rename(target: Target) {
      setTitle(target.title ?? '');
      setRenaming(target);
    },
    async copyId(target: Pick<ConversationDto, 'id'>) {
      try {
        await navigator.clipboard.writeText(target.id);
        toast.success(u.actions.copied);
      } catch {
        window.prompt(u.actions.sessionId, target.id);
      }
    },
    /** Confirmação do "Finalizar sessão"; quem chama finaliza (a janela do agente volta ao fio vazio). */
    confirmFinish: () =>
      confirm({ title: u.actions.finishConfirm, description: u.actions.finishDescription, confirmLabel: u.actions.finish }),
    async remove(target: Target) {
      const name = target.title ?? u.list.untitled;
      const ok = await confirm({
        title: u.actions.deleteConfirm(name),
        description: u.actions.deleteDescription,
        confirmLabel: t.common.delete,
        danger: true,
      });
      if (!ok) return false;
      const result = await run(() => api.del(`/api/conversations/${target.id}`), u.actions.deleted);
      if (result) {
        agents.close(target.id);
        changed(null);
      }
      return Boolean(result);
    },
    /** Bifurcar daqui: copia a sessão inteira (até a última mensagem) numa nova, que vira a ativa do agente. */
    async fork(target: Pick<ConversationDto, 'id'>) {
      const created = await run(async () => {
        const detail = await api.get<ConversationDetail>(`/api/conversations/${target.id}`);
        const last = detail.messages[detail.messages.length - 1];
        if (!last) throw new Error(u.actions.forkEmpty);
        return api.post<ConversationDto>(`/api/conversations/${target.id}/fork`, { messageId: last.id });
      }, u.actions.forked);
      if (created) {
        agents.close(target.id);
        agents.openConversation(created);
        agents.bumpSessions();
        changed(created);
      }
      return created;
    },
  };

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || !title.trim()) return;
    const result = await run(
      () => api.patch<ConversationDto>(`/api/conversations/${renaming.id}`, { title: title.trim() }),
      u.actions.renamed,
    );
    if (result) {
      changed(result);
      setRenaming(null);
    }
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
