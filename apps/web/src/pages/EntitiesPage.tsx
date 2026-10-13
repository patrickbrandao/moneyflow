import { ENTITY_KINDS, type EntitySummary, formatDocument, formatPixKey, type PixKeyType, t } from '@moneyflow/shared';
import { Building2, Plus, Search, Star, Tags, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { recordDragProps } from '../agents/records';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { ExportMenu } from '../components/ExportMenu';
import { EntityFormModal } from '../components/entity/EntityFormModal';
import { EntityTagsModal } from '../components/entity/EntityTagsModal';
import { EntityFilterMenu, entityFilterQuery, FavoriteStar, TagChips, useEntityFilterParams } from '../components/entity/tags';
import { Badge, Button, CopyButton, EmptyRow, Tabs, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { entitiesTable } from '../lib/export-tables';
import { useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

const TABS = ['favorites', 'all', ...ENTITY_KINDS] as const;
type Tab = (typeof TABS)[number];

/**
 * Cadastro global de pessoas e empresas (spec 003): abas Favoritas (a
 * inicial) | Todas | Pessoas | Empresas, busca por nome ou documento (sempre
 * em todas, com as favoritas primeiro) e filtro por tags na URL.
 */
export function EntitiesPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [isNew, setNew] = useParamState('new');
  const [kindParam, setKind] = useParamState('kind');
  const tab: Tab = (TABS as readonly string[]).includes(kindParam ?? '') ? (kindParam as Tab) : 'favorites';
  const [filter, setFilter] = useEntityFilterParams();
  const [archived, setArchived] = useState(false);
  const [managing, setManaging] = useState(false);
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const searching = query.trim() !== '';
  const qs = new URLSearchParams({ limit: '300', ...entityFilterQuery(filter, false) });
  if (searching) qs.set('q', query.trim());
  if (tab === 'person' || tab === 'company') qs.set('kind', tab);
  // A busca procura em todas: na aba Favoritas, com texto, as favoritas só vêm primeiro.
  if (tab === 'favorites' && !searching) qs.set('favorites', '1');
  if (archived) qs.set('archived', '1');
  const { data, error, reload, setData } = useApi<EntitySummary[]>(`/api/entities?${qs}`);
  const cols = 6;
  const markFavorite = (id: string, favorite: boolean) => {
    if (tab === 'favorites' && !searching && !favorite) void reload();
    else setData((rows) => (rows ?? []).map((row) => (row.id === id ? { ...row, isFavorite: favorite } : row)));
  };

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
            {user.role === 'admin' && (
              <Button variant="ghost" onClick={() => setManaging(true)}>
                <Tags /> {t.entityTags.manage}
              </Button>
            )}
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
          value={tab}
          onChange={(key) => setKind(key === 'favorites' ? null : key)}
          items={[
            { key: 'favorites', label: t.entityTags.favorites, icon: <Star /> },
            { key: 'all', label: t.common.all },
            ...ENTITY_KINDS.map((k) => ({ key: k, label: t.entity.kinds[k]! })),
          ]}
        />
        <div className="mb-3 flex items-center gap-3">
          <EntityFilterMenu value={filter} onChange={setFilter} withFavorites={false} />
          <label className="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t.common.showArchived}
          </label>
        </div>
      </div>
      {tab === 'favorites' && searching && <p className="notice mb-3">{t.entityTags.searchingAll}</p>}
      {tab === 'favorites' && !searching && !archived && data && data.length === 0 && filter.tagIds.length === 0 && (
        <div className="notice mb-3 flex flex-wrap items-center justify-between gap-2">
          <span>{t.entityTags.noFavorites}</span>
          <Button size="sm" variant="ghost" onClick={() => setKind('all')}>
            {t.entityTags.seeAll}
          </Button>
        </div>
      )}
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="w-8">
                  <span className="sr-only">{t.entityTags.favorite}</span>
                </th>
                <th>{t.common.name}</th>
                <th>{t.entityTags.tags}</th>
                <th>{t.entity.document}</th>
                <th>{t.entity.primaryPix}</th>
                <th className="num">Caixas</th>
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={cols} />}
              {data && data.length === 0 && (
                <EmptyRow colSpan={cols}>
                  {searching || filter.tagIds.length
                    ? t.common.noResults
                    : tab === 'favorites'
                      ? t.entityTags.noFavorites
                      : 'Nenhuma entidade cadastrada.'}
                </EmptyRow>
              )}
              {data?.map((entity) => (
                <tr
                  key={entity.id}
                  className={`cursor-pointer${entity.archivedAt ? ' is-off' : ''}`}
                  onClick={() => navigate(`/entities/${entity.id}`)}
                  {...recordDragProps({ kind: 'entity', id: entity.id, label: entity.name })}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <FavoriteStar
                      entityId={entity.id}
                      favorite={entity.isFavorite}
                      canEdit={user.canEditRegistry}
                      size="sm"
                      onChanged={(favorite) => markFavorite(entity.id, favorite)}
                    />
                  </td>
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
                  <td>
                    <TagChips tags={entity.tags} />
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
      {managing && <EntityTagsModal onClose={() => setManaging(false)} onChanged={() => void reload()} />}
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
