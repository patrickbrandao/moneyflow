import { ENTITY_KINDS, type EntitySummary, formatDocument, formatPixKey, type PixKeyType, t } from '@moneyflow/shared';
import { Building2, Plus, Search, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { recordDragProps } from '../agents/records';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { ExportMenu } from '../components/ExportMenu';
import { EntityFormModal } from '../components/entity/EntityFormModal';
import { Badge, Button, CopyButton, EmptyRow, Tabs, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { entitiesTable } from '../lib/export-tables';
import { useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

/** Cadastro global de pessoas e empresas (spec 003), com busca por nome ou documento. */
export function EntitiesPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [isNew, setNew] = useParamState('new');
  const [kind, setKind] = useParamState('kind');
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const qs = new URLSearchParams({ limit: '300' });
  if (query.trim()) qs.set('q', query.trim());
  if (kind) qs.set('kind', kind);
  if (archived) qs.set('archived', '1');
  const { data, error, reload } = useApi<EntitySummary[]>(`/api/entities?${qs}`);

  useRegisterCommands(
    user.canEditRegistry ? [{ id: 'entity-new', label: t.palette.newEntity, group: 'Criar', icon: <Plus />, run: () => setNew('1') }] : [],
    [user.canEditRegistry],
  );

  return (
    <div className="page wide">
      <PageHead
        title={t.nav.entities}
        sub="Pessoas e empresas, cadastradas uma vez e usadas por todas as caixas."
        actions={
          <>
            <label className="search-bar">
              <Search />
              <input
                className="field"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Nome, fantasia ou CPF/CNPJ"
                aria-label="Buscar entidades"
              />
            </label>
            <ExportMenu
              size="md"
              build={async () => {
                const all = new URLSearchParams(qs);
                all.set('limit', '500');
                return entitiesTable(await api.get<EntitySummary[]>(`/api/entities?${all}`));
              }}
            />
            {user.canEditRegistry && (
              <Button onClick={() => setNew('1')}>
                <Plus /> {t.palette.newEntity}
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          value={kind ?? 'all'}
          onChange={(key) => setKind(key === 'all' ? null : key)}
          items={[{ key: 'all', label: t.common.all }, ...ENTITY_KINDS.map((k) => ({ key: k, label: t.entity.kinds[k]! }))]}
        />
        <label className="check mb-3">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t.common.showArchived}
        </label>
      </div>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th>{t.entity.document}</th>
                <th>{t.entity.primaryPix}</th>
                <th className="num">Caixas</th>
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={4} />}
              {data && data.length === 0 && <EmptyRow colSpan={4}>{query ? t.common.noResults : 'Nenhuma entidade cadastrada.'}</EmptyRow>}
              {data?.map((entity) => (
                <tr
                  key={entity.id}
                  className={`cursor-pointer${entity.archivedAt ? ' is-off' : ''}`}
                  onClick={() => navigate(`/entities/${entity.id}`)}
                  {...recordDragProps({ kind: 'entity', id: entity.id, label: entity.name })}
                >
                  <td>
                    <span className="flex items-center gap-2">
                      {entity.kind === 'company' ? (
                        <Building2 className="size-4 text-muted" />
                      ) : (
                        <UserRound className="size-4 text-muted" />
                      )}
                      <span className="min-w-0">
                        <span className="row-title">{entity.name}</span>
                        {entity.tradeName && <span className="row-sub">{entity.tradeName}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="mono text-xs">{entity.document ? formatDocument(entity.document) : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {entity.primaryPix ? (
                      <span className="inline-flex items-center gap-1">
                        <Badge tone="outline">{t.entity.pixKinds[entity.primaryPix.keyType]}</Badge>
                        <span className="mono text-xs">
                          {formatPixKey(entity.primaryPix.keyType as PixKeyType, entity.primaryPix.keyValue)}
                        </span>
                        <CopyButton text={entity.primaryPix.keyValue} />
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="num mono">{entity.caixaCount || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isNew && (
        <EntityFormModal
          onClose={() => setNew(null)}
          onSaved={(entity) => {
            setNew(null);
            navigate(`/entities/${entity.id}`);
          }}
        />
      )}
    </div>
  );
}
