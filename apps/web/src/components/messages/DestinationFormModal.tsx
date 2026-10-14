import {
  type AgentOptionDto,
  type CaixaSummary,
  type DestinationOwnerKind,
  type MessageDestinationDto,
  type TelegramInboundConfigDto,
  t,
} from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { FormError, ModalActions } from '../forms';
import { Button, Field, Modal } from '../ui';

/**
 * Cadastrar ou editar um destino do Telegram. O token do bot é write-only:
 * na edição o campo nasce vazio (vazio = mantém) e nunca mostra o valor salvo.
 */
export function DestinationFormModal({
  open,
  destination,
  onClose,
  onSaved,
}: {
  open: boolean;
  destination?: MessageDestinationDto | null;
  onClose: () => void;
  onSaved: (destination: MessageDestinationDto) => void;
}) {
  const user = useUser();
  const editing = Boolean(destination);
  const [name, setName] = useState(destination?.name ?? '');
  const [ownerKind, setOwnerKind] = useState<DestinationOwnerKind>(destination?.ownerKind ?? 'user');
  const [ownerCaixaId, setOwnerCaixaId] = useState(destination?.ownerCaixaId ?? '');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState(destination?.chatId ?? '');
  const [isActive, setIsActive] = useState(destination?.isActive ?? true);
  const [notes, setNotes] = useState(destination?.notes ?? '');
  // "Receber mensagens" (spec 029): só na edição; exige a URL pública HTTPS.
  const [inbound, setInbound] = useState(destination?.inboundEnabled ?? false);
  const [inboundAgentId, setInboundAgentId] = useState(destination?.inboundAgentId ?? '');
  const inboundConfig = useApi<TelegramInboundConfigDto>(open && editing ? '/api/message-destinations/inbound-config' : null);
  const agents = useApi<AgentOptionDto[]>(open && editing ? '/api/agents' : null);
  const agentChoice = inboundAgentId || agents.data?.[0]?.id || '';
  const inboundAvailable = Boolean(inboundConfig.data?.available);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const caixas = useApi<CaixaSummary[]>(open && !editing ? '/api/caixas' : null);
  const writable = (caixas.data ?? []).filter(
    (c) => !c.archivedAt && c.kind === 'general' && (c.myRole === 'admin' || c.myRole === 'editor'),
  );
  const owners: DestinationOwnerKind[] = user.role === 'admin' ? ['user', 'caixa', 'global'] : ['user', 'caixa'];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing && !botToken.trim()) return setError(t.errors.invalidBotToken);
    if (!editing && ownerKind === 'caixa' && !ownerCaixaId) return setError(t.errors.destinationOwner);
    setError(null);
    const inboundChanged = inbound !== (destination?.inboundEnabled ?? false) || (inbound && agentChoice !== destination?.inboundAgentId);
    const body = editing
      ? {
          name,
          chatId: chatId.trim(),
          botToken: botToken.trim() || undefined,
          isActive,
          notes,
          ...(inboundChanged ? { inboundEnabled: inbound && isActive, inboundAgentId: inbound ? agentChoice : undefined } : {}),
        }
      : {
          name,
          ownerKind,
          ownerCaixaId: ownerKind === 'caixa' ? ownerCaixaId : null,
          botToken: botToken.trim(),
          chatId: chatId.trim(),
          isActive,
          notes,
        };
    const saved = await run(
      () =>
        destination
          ? api.patch<MessageDestinationDto>(`/api/message-destinations/${destination.id}`, body)
          : api.post<MessageDestinationDto>('/api/message-destinations', body),
      editing ? t.messages.saved : t.messages.created,
    );
    if (saved) onSaved(saved);
  }

  return (
    <Modal open={open} title={editing ? t.messages.editDestination : t.messages.newDestination} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" autoComplete="off">
        <Field label={t.messages.name}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={120} />
        </Field>
        {!editing && (
          <Field label={t.messages.owner}>
            <select className="field" value={ownerKind} onChange={(e) => setOwnerKind(e.target.value as DestinationOwnerKind)}>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {t.messages.ownerKinds[o]}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!editing && ownerKind === 'caixa' && (
          <Field label={t.messages.ownerCaixa}>
            <select className="field" value={ownerCaixaId} onChange={(e) => setOwnerCaixaId(e.target.value)} required>
              <option value="">{t.common.choose}</option>
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label={t.messages.botToken}
          hint={editing ? `${t.messages.botTokenSaved(destination?.botId ?? null)}. ${t.messages.botTokenKeep}` : t.messages.botTokenHint}
        >
          <input
            className="field field-mono"
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={editing ? '••••••••' : '123456789:AA…'}
            autoComplete="new-password"
            spellCheck={false}
            required={!editing}
            aria-label={t.messages.botToken}
          />
        </Field>
        <Field label={t.messages.chatId} hint={t.messages.chatIdHint}>
          <input
            className="field field-mono"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            required
            spellCheck={false}
            aria-label={t.messages.chatId}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> {t.messages.active}
        </label>
        {editing && destination?.isActive && !isActive && <p className="hint">{t.messages.deactivateHint}</p>}
        {editing && (
          <div className="well grid gap-2" data-testid="destination-inbound">
            <label className="check">
              <input
                type="checkbox"
                checked={inbound}
                disabled={!inboundAvailable && !inbound}
                onChange={(e) => setInbound(e.target.checked)}
                aria-label={t.agentsUi.telegram.inbound}
              />{' '}
              {t.agentsUi.telegram.inbound}
            </label>
            <p className="hint">{inboundAvailable || inbound ? t.agentsUi.telegram.inboundHint : t.agentsUi.telegram.inboundUnavailable}</p>
            {inbound && (
              <Field label={t.agentsUi.telegram.inboundAgent}>
                <select
                  className="field"
                  value={agentChoice}
                  onChange={(e) => setInboundAgentId(e.target.value)}
                  aria-label={t.agentsUi.telegram.inboundAgent}
                >
                  {agents.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}
        <Field label={t.messages.notes}>
          <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !chatId.trim()}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
