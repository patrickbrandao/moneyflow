import { type EntityTag, type EntityTagMode, type EntityTagRef, t } from '@moneyflow/shared';
import { ChevronDown, Plus, Search, Star, Tags, X } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { useSetParams } from '../../lib/params';
import { Button, cx, Menu, useClickOutside } from '../ui';

/*
 * Tags e favoritas de entidade (spec 003): chips com a cor da tag
 * (var(--port-N)), seletor com busca (o admin cria tag nova ali mesmo), a
 * estrela de favorita e o filtro de entidades (tags Qualquer uma/Todas e Só
 * favoritas) usado na listagem, nos relatórios e no canvas.
 */

const NAME = t.entityTags;

/** Catálogo de tags (ativas; `archived` traz também as arquivadas). */
export function useEntityTags(archived = false) {
  return useApi<EntityTag[]>(`/api/entity-tags${archived ? '?archived=1' : ''}`);
}

/** Primeiro slot de cor (1–12) ainda não usado por uma tag ativa. */
export function suggestSlot(tags: Pick<EntityTag, 'colorSlot' | 'archivedAt'>[]): number {
  const used = new Set(tags.filter((tag) => !tag.archivedAt).map((tag) => tag.colorSlot));
  for (let slot = 1; slot <= 12; slot += 1) if (!used.has(slot)) return slot;
  return ((tags.length % 12) + 1) as number;
}

export function TagDot({ slot }: { slot: number }) {
  return <span className="cat-dot" style={{ background: `var(--port-${slot})` }} aria-hidden />;
}

/** Chip da tag: bolinha da cor + nome; arquivada esmaecida com "(arquivada)". */
export function TagChip({ tag, onRemove }: { tag: EntityTagRef; onRemove?: () => void }) {
  return (
    <span className={cx('tag-chip', tag.archived && 'is-off')} data-tag={tag.name}>
      <TagDot slot={tag.colorSlot} />
      <span className="truncate">{tag.name}</span>
      {tag.archived && <span className="text-faint">{NAME.archivedSuffix}</span>}
      {onRemove && (
        <button type="button" className="x" onClick={onRemove} aria-label={NAME.remove(tag.name)} title={NAME.remove(tag.name)}>
          <X />
        </button>
      )}
    </span>
  );
}

/** Chips das tags; acima de `max`, "+N". */
export function TagChips({ tags, max = 3 }: { tags: EntityTagRef[]; max?: number }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="tag-chips">
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {rest > 0 && (
        <span
          className="tag-chip more"
          title={tags
            .slice(max)
            .map((tag) => tag.name)
            .join(', ')}
        >
          {NAME.more(rest)}
        </span>
      )}
    </span>
  );
}

/** Só as bolinhas (opções do seletor de entidade). */
export function TagDots({ tags }: { tags: EntityTagRef[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="tag-dots" title={tags.map((tag) => tag.name).join(', ')}>
      {tags.slice(0, 5).map((tag) => (
        <TagDot key={tag.id} slot={tag.colorSlot} />
      ))}
    </span>
  );
}

/** Estrela da favorita: clicável para quem edita o cadastro; para os demais, só indicação. */
export function FavoriteStar({
  entityId,
  favorite,
  canEdit,
  onChanged,
  size = 'md',
}: {
  entityId: string;
  favorite: boolean;
  canEdit: boolean;
  onChanged?: (favorite: boolean) => void;
  size?: 'sm' | 'md';
}) {
  const { run, busy } = useAction();
  const label = favorite ? NAME.unmarkFavorite : NAME.markFavorite;
  const icon = <Star className={cx(size === 'sm' ? 'size-4' : 'size-[18px]')} />;
  if (!canEdit) {
    return favorite ? (
      <span className="fav-star on" role="img" aria-label={NAME.favorite} title={NAME.favorite}>
        {icon}
      </span>
    ) : (
      <span className="fav-star" aria-hidden />
    );
  }
  return (
    <button
      type="button"
      className={cx('fav-star', favorite && 'on')}
      aria-pressed={favorite}
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={async (event) => {
        event.stopPropagation();
        const next = !favorite;
        const ok = await run(() => api.patch(`/api/entities/${entityId}`, { isFavorite: next }), next ? NAME.favoriteOn : NAME.favoriteOff);
        if (ok) onChanged?.(next);
      }}
    >
      {icon}
    </button>
  );
}

/**
 * Seletor de tags da entidade: lista com busca e bolinha de cor, escolhidas
 * como chips removíveis. O admin cria uma tag nova digitando um nome que não
 * existe ("Criar tag 'X'", com a cor sugerida).
 */
export function TagPicker({
  value,
  onChange,
  current = [],
  canCreate,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  /** Tags que a entidade já tem (inclusive arquivadas: continuam até serem removidas). */
  current?: EntityTagRef[];
  canCreate: boolean;
}) {
  const catalog = useEntityTags();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<EntityTag[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const { run, busy } = useAction();

  const active = useMemo(() => {
    const byId = new Map<string, EntityTag>();
    for (const tag of [...(catalog.data ?? []), ...created]) byId.set(tag.id, tag);
    return [...byId.values()];
  }, [catalog.data, created]);
  const refOf = (id: string): EntityTagRef | null => {
    const tag = active.find((x) => x.id === id);
    if (tag) return { id: tag.id, name: tag.name, colorSlot: tag.colorSlot, archived: false };
    return current.find((x) => x.id === id) ?? null;
  };
  const term = query.trim().toLocaleLowerCase('pt-BR');
  const options = active.filter((tag) => !value.includes(tag.id) && (!term || tag.name.toLocaleLowerCase('pt-BR').includes(term)));
  const exact = active.some((tag) => tag.name.toLocaleLowerCase('pt-BR') === term);

  async function create() {
    const name = query.trim();
    const tag = await run(() => api.post<EntityTag>('/api/entity-tags', { name, colorSlot: suggestSlot(active) }), NAME.created);
    if (!tag) return;
    setCreated((list) => [...list, tag]);
    onChange([...value, tag.id]);
    setQuery('');
  }

  return (
    <div className="picker tag-picker" ref={ref}>
      {value.length > 0 && (
        <div className="tag-chips mb-2">
          {value.map((id) => {
            const tag = refOf(id);
            return tag ? <TagChip key={id} tag={tag} onRemove={() => onChange(value.filter((x) => x !== id))} /> : null;
          })}
        </div>
      )}
      <label className="search-bar w-full">
        <Search />
        <input
          className="field w-full"
          value={query}
          placeholder={NAME.pickerPlaceholder}
          aria-label={NAME.addTag}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (options[0]) {
              onChange([...value, options[0].id]);
              setQuery('');
            } else if (canCreate && term && !exact) void create();
          }}
        />
      </label>
      {open && (
        <div className="menu" role="listbox" aria-label={NAME.tags}>
          {options.map((tag) => (
            <button
              key={tag.id}
              type="button"
              role="option"
              aria-selected={false}
              className="mi"
              onClick={() => {
                onChange([...value, tag.id]);
                setQuery('');
              }}
            >
              <TagDot slot={tag.colorSlot} />
              <span className="min-w-0 flex-1 truncate text-left">{tag.name}</span>
            </button>
          ))}
          {canCreate && term && !exact && (
            <button type="button" className="mi" disabled={busy} onClick={() => void create()}>
              <Plus />
              <span className="min-w-0 flex-1 truncate text-left">{NAME.createInline(query.trim())}</span>
            </button>
          )}
          {options.length === 0 && !(canCreate && term && !exact) && <div className="hd">{NAME.pickerEmpty}</div>}
        </div>
      )}
    </div>
  );
}

/* ---------------- filtro de entidades (tags e favoritas) ---------------- */

export type EntityFilterState = { tagIds: string[]; tagMode: EntityTagMode; favorites: boolean };

/** O filtro na URL: `tags=<id>,<id>&tagMode=any|all` e, nos relatórios e no canvas, `favorites=1`. */
export function useEntityFilterParams(): [EntityFilterState, (next: Partial<EntityFilterState>) => void] {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const tags = params.get('tags') ?? '';
  const tagMode: EntityTagMode = params.get('tagMode') === 'all' ? 'all' : 'any';
  const favorites = params.get('favorites') === '1';
  const filter = useMemo(() => ({ tagIds: tags.split(',').filter(Boolean), tagMode, favorites }), [tags, tagMode, favorites]);
  const set = useCallback(
    (next: Partial<EntityFilterState>) => {
      const patch: Record<string, string | null> = {};
      if (next.tagIds !== undefined) patch.tags = next.tagIds.length ? next.tagIds.join(',') : null;
      if (next.tagMode !== undefined) patch.tagMode = next.tagMode === 'all' ? 'all' : null;
      if (next.favorites !== undefined) patch.favorites = next.favorites ? '1' : null;
      setParams(patch);
    },
    [setParams],
  );
  return [filter, set];
}

export const entityFilterActive = (filter: EntityFilterState, withFavorites = true) =>
  filter.tagIds.length > 0 || (withFavorites && filter.favorites);

/** Parâmetros da API (`tagIds`, `tagMode`, `favorites`). */
export function entityFilterQuery(filter: EntityFilterState, withFavorites = true): Record<string, string> {
  const out: Record<string, string> = {};
  if (filter.tagIds.length) {
    out.tagIds = filter.tagIds.join(',');
    if (filter.tagMode === 'all') out.tagMode = 'all';
  }
  if (withFavorites && filter.favorites) out.favorites = '1';
  return out;
}

/** Texto do filtro para o cabeçalho do CSV/PDF. */
export function entityFilterLabel(filter: EntityFilterState, tags: EntityTag[] | undefined, withFavorites = true): string | null {
  const parts: string[] = [];
  if (filter.tagIds.length) {
    const names = filter.tagIds.map((id) => tags?.find((tag) => tag.id === id)?.name ?? id.slice(0, 8));
    parts.push(NAME.exportTags(names, filter.tagMode));
  }
  if (withFavorites && filter.favorites) parts.push(NAME.exportFavorites);
  return parts.length ? NAME.exportHeader(parts) : null;
}

/** Botão + popover do filtro: tags ativas (várias), Qualquer uma/Todas e, opcional, Só favoritas. */
export function EntityFilterMenu({
  value,
  onChange,
  withFavorites = true,
  extra,
}: {
  value: EntityFilterState;
  onChange: (next: Partial<EntityFilterState>) => void;
  withFavorites?: boolean;
  extra?: ReactNode;
}) {
  const catalog = useEntityTags();
  const tags = catalog.data ?? [];
  const count = value.tagIds.length + (withFavorites && value.favorites ? 1 : 0);
  const label =
    [value.tagIds.length ? NAME.filterTags(value.tagIds.length) : null, withFavorites && value.favorites ? NAME.onlyFavorites : null]
      .filter(Boolean)
      .join(' · ') || NAME.tags;
  const toggle = (id: string) =>
    onChange({ tagIds: value.tagIds.includes(id) ? value.tagIds.filter((x) => x !== id) : [...value.tagIds, id] });
  return (
    <Menu
      align="right"
      trigger={(props) => (
        <Button size="sm" variant={count ? 'quiet' : 'ghost'} {...props} aria-label={NAME.filter}>
          <Tags /> {label} <ChevronDown />
        </Button>
      )}
    >
      <div className="caixa-filter entity-filter" role="group" aria-label={NAME.filter}>
        {withFavorites && (
          <>
            <label>
              <input type="checkbox" checked={value.favorites} onChange={(e) => onChange({ favorites: e.target.checked })} />
              <Star />
              <span className="truncate">{NAME.onlyFavorites}</span>
            </label>
            <div className="sep" role="separator" />
          </>
        )}
        <div className="segmented mx-2 my-1" role="group" aria-label={NAME.modeLabel}>
          {(['any', 'all'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={value.tagMode === mode ? 'active' : ''}
              aria-pressed={value.tagMode === mode}
              onClick={() => onChange({ tagMode: mode })}
            >
              {mode === 'any' ? NAME.modeAny : NAME.modeAll}
            </button>
          ))}
        </div>
        {tags.length === 0 && <div className="hd">{NAME.empty}</div>}
        {tags.map((tag) => (
          <label key={tag.id}>
            <input type="checkbox" checked={value.tagIds.includes(tag.id)} onChange={() => toggle(tag.id)} aria-label={tag.name} />
            <TagDot slot={tag.colorSlot} />
            <span className="truncate">{tag.name}</span>
          </label>
        ))}
        {extra}
        {count > 0 && (
          <>
            <div className="sep" role="separator" />
            <button type="button" className="mi" onClick={() => onChange({ tagIds: [], favorites: false, tagMode: 'any' })}>
              {NAME.clear}
            </button>
          </>
        )}
      </div>
    </Menu>
  );
}
