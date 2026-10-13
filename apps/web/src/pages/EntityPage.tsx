import { type ContractRow, type EntityDetail, formatCep, formatDate, formatDocument, formatPixKey, t } from '@moneyflow/shared';
import {
  Archive,
  ArchiveRestore,
  Building2,
  Contact,
  Handshake,
  History,
  Landmark,
  Link2,
  MapPin,
  Paperclip,
  Pencil,
  Plus,
  QrCode,
  Star,
  Trash2,
  UserRound,
  Wallet,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { AttachmentsPanel } from '../components/attachments/AttachmentsPanel';
import { AuditHistory } from '../components/audit/AuditHistory';
import { CaixaFormModal } from '../components/CaixaFormModal';
import { ContractsTable } from '../components/contracts/ContractsTable';
import { LoadError, PageHead } from '../components/domain';
import { AddressModal, BankAccountModal, ContactModal, LinkModal, PixKeyModal } from '../components/entity/ChildModals';
import { EntityFormModal } from '../components/entity/EntityFormModal';
import { FavoriteStar, TagChip } from '../components/entity/tags';
import { useCrumbs } from '../components/shell/Layout';
import { Badge, Button, CopyButton, Panel, Skel, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';

type Editing =
  | { kind: 'entity' }
  | { kind: 'pix'; item?: EntityDetail['pixKeys'][number] }
  | { kind: 'contact'; item?: EntityDetail['contacts'][number] }
  | { kind: 'address'; item?: EntityDetail['addresses'][number] }
  | { kind: 'bank'; item?: EntityDetail['bankAccounts'][number] }
  | { kind: 'link' }
  | { kind: 'caixa' }
  | { kind: 'history' };

/** Detalhe da entidade: PIX (com copiar), contatos, endereços, dados bancários, vínculos e caixas. */
export function EntityPage() {
  const { id = '' } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const { data: entity, error, reload } = useApi<EntityDetail>(`/api/entities/${id}`);
  // Contratos com esta contraparte, nas caixas que o usuário lê (spec 020).
  const contracts = useApi<ContractRow[]>(`/api/contracts?entityId=${id}&limit=100`);
  const [editing, setEditing] = useState<Editing | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const canEdit = user.canEditRegistry;
  useCrumbs(entity ? [{ label: entity.name }] : []);
  useAgentScreenContext(entity ? { title: entity.name, record: { kind: 'entity', id: entity.id, label: entity.name } } : null);

  useRegisterCommands(
    entity && canEdit
      ? [
          {
            id: 'entity-edit',
            label: `Editar ${entity.name}`,
            group: 'Recurso',
            icon: <Pencil />,
            run: () => setEditing({ kind: 'entity' }),
          },
          {
            id: 'entity-pix',
            label: `Nova chave PIX para ${entity.name}`,
            group: 'Criar',
            icon: <QrCode />,
            run: () => setEditing({ kind: 'pix' }),
          },
        ]
      : [],
    [entity?.id, canEdit],
  );

  if (error) {
    return (
      <div className="page">
        <LoadError error={error} onRetry={() => void reload()} />
      </div>
    );
  }
  if (!entity) {
    return (
      <div className="page wide">
        <Skel h={34} w={320} />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Skel h={160} />
          <Skel h={160} />
        </div>
      </div>
    );
  }

  const saved = () => {
    setEditing(null);
    void reload();
  };

  async function removeChild(segment: string, childId: string, label: string) {
    const ok = await confirm({ title: `Remover ${label}?`, confirmLabel: t.common.remove, danger: true });
    if (ok && (await run(() => api.del(`/api/entities/${id}/${segment}/${childId}`), 'Removido.'))) void reload();
  }

  async function archive() {
    if (!entity) return;
    const ok = await confirm({
      title: `Excluir ${entity.name}?`,
      description: 'Sem vínculos ela é excluída; usada em títulos ou caixas, é arquivada.',
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () => api.del<{ archived: boolean }>(`/api/entities/${entity.id}`),
      (r) => t.common.deletedOrArchived(r.archived),
    );
    if (result?.archived) void reload();
    else if (result) navigate('/entities');
  }

  async function restore() {
    if (await run(() => api.post(`/api/entities/${id}/restore`), 'Entidade restaurada.')) void reload();
  }

  const add = (kind: Editing['kind']) =>
    canEdit ? (
      <Button size="sm" variant="ghost" onClick={() => setEditing({ kind } as Editing)}>
        <Plus /> {t.common.add}
      </Button>
    ) : undefined;

  const actions = (onEdit: () => void, segment: string, childId: string, label: string) =>
    canEdit && (
      <span className="row-actions">
        <button type="button" className="row-action" title={t.common.edit} onClick={onEdit}>
          <Pencil />
        </button>
        <button
          type="button"
          className="row-action danger"
          title={t.common.remove}
          onClick={() => void removeChild(segment, childId, label)}
        >
          <Trash2 />
        </button>
      </span>
    );

  return (
    <div className="page wide">
      <PageHead
        title={
          <span className="inline-flex items-center gap-2">
            <FavoriteStar entityId={entity.id} favorite={entity.isFavorite} canEdit={canEdit} onChanged={() => void reload()} />
            <span className="min-w-0">{entity.name}</span>
          </span>
        }
        sub={
          <>
            {entity.tradeName && `${entity.tradeName} · `}
            {entity.document ? <span className="mono">{formatDocument(entity.document)}</span> : 'sem documento'}
            {entity.birthDate && ` · ${t.entity.birthDate} ${formatDate(entity.birthDate)}`}
          </>
        }
        actions={
          <>
            <Button variant="quiet" onClick={() => setEditing({ kind: 'history' })}>
              <History /> {t.audit.history}
            </Button>
            {canEdit && (
              <>
                <Button variant="ghost" onClick={() => setEditing({ kind: 'entity' })}>
                  <Pencil /> {t.common.edit}
                </Button>
                {entity.archivedAt ? (
                  <Button variant="ghost" onClick={() => void restore()}>
                    <ArchiveRestore /> {t.common.restore}
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => void archive()}>
                    <Archive /> {t.common.delete}
                  </Button>
                )}
              </>
            )}
          </>
        }
      >
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone="outline">
            {entity.kind === 'company' ? <Building2 /> : <UserRound />} {t.entity.kinds[entity.kind]}
          </Badge>
          {entity.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
          {entity.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
        </div>
      </PageHead>

      {entity.notes && <p className="notice info mb-4 whitespace-pre-wrap">{entity.notes}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t.entity.pixKeys} icon={<QrCode />} actions={add('pix')}>
          <Items empty="Nenhuma chave PIX.">
            {entity.pixKeys.map((key) => (
              <div key={key.id} className="item">
                <div className="grow">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="outline">{t.entity.pixKinds[key.keyType]}</Badge>
                    <span className="mono truncate text-[13px] text-ink">{formatPixKey(key.keyType, key.keyValue)}</span>
                    {key.isPrimary && (
                      <Badge tone="accent">
                        <Star /> {t.common.primary}
                      </Badge>
                    )}
                  </div>
                  {(key.label || key.bankCode) && (
                    <div className="text-[12px] text-muted">
                      {[key.label, key.bankCode && `banco ${key.bankCode}`].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <CopyButton text={key.keyValue} />
                {actions(() => setEditing({ kind: 'pix', item: key }), 'pix-keys', key.id, 'a chave PIX')}
              </div>
            ))}
          </Items>
        </Panel>

        <Panel title={t.entity.contacts} icon={<Contact />} actions={add('contact')}>
          <Items empty="Nenhum contato.">
            {entity.contacts.map((c) => (
              <div key={c.id} className="item">
                <div className="grow">
                  <div className="flex items-center gap-2 text-[13px] text-ink">
                    <Badge tone="outline">{t.entity.contactKinds[c.kind]}</Badge>
                    <span className="truncate">{c.value}</span>
                    {c.isPrimary && <Badge tone="accent">{t.common.primary}</Badge>}
                  </div>
                  {c.label && <div className="text-[12px] text-muted">{c.label}</div>}
                </div>
                <CopyButton text={c.value} />
                {actions(() => setEditing({ kind: 'contact', item: c }), 'contacts', c.id, 'o contato')}
              </div>
            ))}
          </Items>
        </Panel>

        <Panel title={t.entity.addresses} icon={<MapPin />} actions={add('address')}>
          <Items empty="Nenhum endereço.">
            {entity.addresses.map((a) => (
              <div key={a.id} className="item">
                <div className="grow text-[13px]">
                  <div className="text-ink">
                    {[a.street, a.number].filter(Boolean).join(', ')}
                    {a.complement && ` — ${a.complement}`}
                  </div>
                  <div className="text-muted">
                    {[a.district, `${a.city}/${a.state}`, a.postalCode && formatCep(a.postalCode)].filter(Boolean).join(' · ')}
                    {a.label && ` · ${a.label}`}
                  </div>
                </div>
                {actions(() => setEditing({ kind: 'address', item: a }), 'addresses', a.id, 'o endereço')}
              </div>
            ))}
          </Items>
        </Panel>

        <Panel title={t.entity.bankAccounts} icon={<Landmark />} actions={add('bank')}>
          <Items empty="Nenhum dado bancário.">
            {entity.bankAccounts.map((b) => (
              <div key={b.id} className="item">
                <div className="grow text-[13px]">
                  <div className="mono text-ink">
                    {[b.bankCode && `banco ${b.bankCode}`, b.branch && `ag ${b.branch}`, `cc ${b.accountNumber}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="text-muted">
                    {[t.entity.bankAccountTypes[b.accountType], b.holderName, b.label].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {actions(() => setEditing({ kind: 'bank', item: b }), 'bank-accounts', b.id, 'o dado bancário')}
              </div>
            ))}
          </Items>
        </Panel>

        <Panel title={t.entity.links} icon={<Link2 />} actions={add('link')}>
          <Items empty="Nenhum vínculo.">
            {entity.links.map((l) => (
              <div key={l.id} className="item">
                <div className="grow text-[13px] text-dim">
                  {l.direction === 'out' ? t.entity.linkKinds[l.kind] : t.entity.linkKindsInverse[l.kind]}{' '}
                  <Link className="link" to={`/entities/${l.otherEntityId}`}>
                    {l.otherEntityName}
                  </Link>
                  {l.notes && <div className="text-[12px] text-muted">{l.notes}</div>}
                </div>
                {canEdit && (
                  <button
                    type="button"
                    className="row-action danger"
                    title={t.common.remove}
                    onClick={() => void removeChild('links', l.id, 'o vínculo')}
                  >
                    <Trash2 />
                  </button>
                )}
              </div>
            ))}
          </Items>
        </Panel>

        <Panel title={t.entity.caixas} icon={<Wallet />} actions={add('caixa')}>
          <Items empty="Não é titular de nenhuma caixa.">
            {entity.caixas.map((c) => (
              <div key={c.id} className={`item${c.archivedAt ? ' opacity-60' : ''}`}>
                <Wallet className="size-4 text-muted" />
                <div className="grow text-[13px]">
                  {c.visible ? (
                    <Link className="link" to={`/caixas/${c.id}`}>
                      {c.name}
                    </Link>
                  ) : (
                    <span className="text-dim" title="Você não tem acesso a esta caixa">
                      {c.name}
                    </span>
                  )}
                </div>
                {c.isPrimary && <Badge tone="accent">{t.common.primary}</Badge>}
                {c.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
              </div>
            ))}
          </Items>
        </Panel>

        <Panel title={t.attachments.title} icon={<Paperclip />}>
          <AttachmentsPanel target="entity" targetId={entity.id} canWrite={canEdit} />
        </Panel>
      </div>

      <div className="mt-6">
        <Panel
          title={t.contracts.entityTab}
          icon={<Handshake />}
          actions={
            <Link className="btn btn-quiet btn-sm" to={`/contracts?entity=${entity.id}`}>
              {t.contracts.title}
            </Link>
          }
        >
          <ContractsTable rows={contracts.data} empty={t.contracts.entityTabEmpty} showEntity={false} />
        </Panel>
      </div>

      {editing?.kind === 'entity' && <EntityFormModal entity={entity} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing?.kind === 'pix' && <PixKeyModal entityId={id} item={editing.item} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing?.kind === 'contact' && <ContactModal entityId={id} item={editing.item} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing?.kind === 'address' && <AddressModal entityId={id} item={editing.item} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing?.kind === 'bank' && <BankAccountModal entityId={id} item={editing.item} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing?.kind === 'history' && (
        <AuditHistory table="entities" recordId={entity.id} title={t.audit.entityHistory} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === 'link' && <LinkModal entityId={id} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing?.kind === 'caixa' && (
        <CaixaFormModal
          open
          initialHolder={{ id: entity.id, name: entity.name }}
          onClose={() => setEditing(null)}
          onSaved={(caixa) => navigate(`/caixas/${caixa.id}`)}
        />
      )}
    </div>
  );
}

function Items({ children, empty }: { children: ReactNode[]; empty: string }) {
  if (children.length === 0) return <p className="text-[13px] text-faint">{empty}</p>;
  return <div className="item-list">{children}</div>;
}
