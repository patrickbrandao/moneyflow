import {
  type DatePeriod,
  formatDate,
  formatDateTime,
  NOTE_KIND_ORDER,
  NOTE_KINDS,
  type NoteKind,
  type NoteListItem,
  type NotePage,
  t,
  todayIso,
  type UserRow,
} from '@moneyflow/shared';
import { Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { useSetParams } from '../../lib/params';
import { DateRangeFilter, useStoredPeriod } from '../DateRangeFilter';
import { LoadError, SkelRows } from '../domain';
import { type EntityOption, EntityPicker } from '../forms';
import { Badge, Button, cx, EmptyRow, useDebounced } from '../ui';
import { NoteKindDot, NoteKindLabel } from './kinds';
import { NoteCalendar, type NoteCalendarView } from './NoteCalendar';
import { NoteModal } from './NoteModal';

/*
 * Anotações (spec 035): calendário (opcional), filtros e a tabela, com a
 * janela da anotação. Usado na tela /notes (com o calendário) e na aba
 * Anotações da entidade (presa a ela). A URL guarda a visão do calendário
 * (view, year, month), os tipos (kinds), a nota aberta (note) e a nova (new);
 * o período é o do DateRangeFilter, lembrado por visão (o dia clicado vira o período).
 */

const U = t.notes.ui;
const F = U.filters;
const PAGE = 100;

export function NotesBrowser({
  entity,
  withCalendar,
  onChanged,
}: {
  entity?: EntityOption;
  withCalendar?: boolean;
  /** Uma anotação foi criada, editada ou arquivada (a ficha da entidade recarrega o selo). */
  onChanged?: () => void;
}) {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const today = todayIso();
  const view: NoteCalendarView = params.get('view') === 'month' ? 'month' : 'year';
  const year = Number(params.get('year')) || Number(today.slice(0, 4));
  const month = Math.min(12, Math.max(1, Number(params.get('month')) || Number(today.slice(5, 7))));
  const kinds = (params.get('kinds') ?? '').split(',').filter((k): k is NoteKind => (NOTE_KINDS as readonly string[]).includes(k));
  const noteId = params.get('note');
  const isNew = params.get('new') === '1';

  // Na tela: o período lembrado (padrão 60 dias atrás e 30 à frente). Na ficha da entidade, começa sem
  // período (todas as anotações dela, uma linha por anotação); o filtro continua lá para quem quiser.
  const [storedPeriod, setStoredPeriod] = useStoredPeriod('notes');
  const [entityPeriod, setEntityPeriod] = useState<DatePeriod>({ from: '', to: '' });
  const [period, setPeriod] = entity ? [entityPeriod, setEntityPeriod] : [storedPeriod, setStoredPeriod];
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [scope, setScope] = useState<'all' | 'mine' | 'global'>('all');
  const [authorId, setAuthorId] = useState('');
  const [archived, setArchived] = useState(false);
  const [entityFilter, setEntityFilter] = useState<EntityOption | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const users = useApi<UserRow[]>(isAdmin ? '/api/users' : null);

  const selectedDay = period.from && period.from === period.to ? period.from : null;
  const entityId = entity?.id ?? entityFilter?.id ?? null;

  const qs = new URLSearchParams({ limit: String(PAGE) });
  if (period.from && period.to) {
    qs.set('from', period.from);
    qs.set('to', period.to);
  }
  if (kinds.length) qs.set('kinds', kinds.join(','));
  if (!entity && entityId) qs.set('entityId', entityId);
  if (scope !== 'all') qs.set('scope', scope);
  if (isAdmin && authorId) qs.set('authorId', authorId);
  if (query.trim()) qs.set('q', query.trim());
  if (archived) qs.set('archived', '1');
  qs.set('r', String(reloadKey));
  const base = entity ? `/api/entities/${entity.id}/notes` : '/api/notes';
  const path = `${base}?${qs}`;
  const first = useApi<NotePage>(path);
  const [more, setMore] = useState<{ path: string; items: NoteListItem[]; next: string | null } | null>(null);
  const extra = more?.path === path ? more : null;
  const items = useMemo(() => [...(first.data?.items ?? []), ...(extra?.items ?? [])], [first.data, extra]);
  const nextCursor = extra ? extra.next : (first.data?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    const cursorQs = new URLSearchParams(qs);
    cursorQs.set('cursor', nextCursor);
    const page = await api.get<NotePage>(`${base}?${cursorQs}`).catch(() => null);
    setLoadingMore(false);
    if (page) setMore({ path, items: [...(extra?.items ?? []), ...page.items], next: page.nextCursor });
  }

  const toggleKind = (kind: NoteKind) => {
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    setParams({ kinds: next.length ? NOTE_KIND_ORDER.filter((k) => next.includes(k)).join(',') : null });
  };

  const saved = () => {
    setReloadKey((k) => k + 1);
    onChanged?.();
  };
  useEffect(() => {
    // Trocar de entidade (outra ficha) começa sem páginas extras.
    setMore(null);
  }, [entity?.id]);

  const newDate = selectedDay ?? today;
  const cols = 7;

  return (
    <div className="notes-browser">
      {withCalendar && (
        <NoteCalendar
          view={view}
          year={year}
          month={month}
          selectedDay={selectedDay}
          entityId={entityId}
          kinds={kinds}
          reloadKey={reloadKey}
          onSelectDay={(day) => setPeriod({ from: day, to: day })}
          onNavigate={(next) => setParams({ view: next.view, year: String(next.year), month: String(next.month) })}
        />
      )}

      <div className="notes-filters">
        <DateRangeFilter value={period} onChange={setPeriod} />
        {selectedDay && <Badge tone="accent">{U.selectedDay(formatDate(selectedDay))}</Badge>}
      </div>
      <div className="notes-filters">
        <fieldset className="note-chips" aria-label={F.kinds}>
          {NOTE_KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              className={cx('note-chip', kinds.includes(kind) && 'active')}
              aria-pressed={kinds.includes(kind)}
              onClick={() => toggleKind(kind)}
            >
              <NoteKindDot kind={kind} />
              {t.notes.kinds[kind]}
            </button>
          ))}
        </fieldset>
        <label className="search-bar">
          <Search />
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder={F.search} aria-label={F.search} />
        </label>
        {!entity && (
          <div className="notes-entity-filter">
            <EntityPicker value={entityFilter} onChange={setEntityFilter} placeholder={F.entity} ariaLabel={F.entity} />
          </div>
        )}
        <select className="field field-auto" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label={F.scope}>
          <option value="all">{F.scopeAll}</option>
          <option value="mine">{F.scopeMine}</option>
          <option value="global">{F.scopeGlobal}</option>
        </select>
        {isAdmin && (
          <select className="field field-auto" value={authorId} onChange={(e) => setAuthorId(e.target.value)} aria-label={F.author}>
            <option value="">{F.anyAuthor}</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username}
              </option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {F.archived}
        </label>
        <Button className="ml-auto" onClick={() => setParams({ new: '1', note: null })}>
          <Plus /> {t.notes.newNote}
        </Button>
      </div>

      {first.error ? (
        <LoadError error={first.error} onRetry={() => void first.reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data notes-table">
            <thead>
              <tr>
                <th>{U.columns.date}</th>
                <th>{U.columns.kind}</th>
                <th>{U.columns.title}</th>
                {!entity && <th>{U.columns.entity}</th>}
                <th>{U.columns.author}</th>
                <th>{U.columns.scope}</th>
                <th>{U.columns.repeat}</th>
              </tr>
            </thead>
            <tbody>
              {!first.data && <SkelRows cols={entity ? cols - 1 : cols} />}
              {first.data && items.length === 0 && (
                <EmptyRow colSpan={entity ? cols - 1 : cols}>{entity ? U.entityEmpty : `${U.empty} ${U.emptyHint}`}</EmptyRow>
              )}
              {items.map((note) => (
                <tr
                  key={`${note.id}:${note.occursOn}`}
                  className={cx('cursor-pointer', note.archivedAt && 'is-off')}
                  onClick={() => setParams({ note: note.id, new: null })}
                  data-note={note.title}
                >
                  <td className="mono text-xs whitespace-nowrap">{formatDate(note.occursOn)}</td>
                  <td>
                    <NoteKindLabel kind={note.kind} />
                  </td>
                  <td>
                    <span className="row-title">{note.title}</span>
                    {note.bodyExcerpt && <span className="row-sub note-excerpt">{note.bodyExcerpt}</span>}
                  </td>
                  {!entity && (
                    <td>
                      <Link className="link" to={`/entities/${note.object.id}`} onClick={(e) => e.stopPropagation()}>
                        {note.object.name}
                      </Link>
                    </td>
                  )}
                  <td className="text-dim">@{note.authorUsername}</td>
                  <td>
                    <Badge tone={note.scope === 'global' ? 'info' : 'outline'}>{t.notes.scopes[note.scope]}</Badge>
                  </td>
                  <td className="text-xs">
                    {note.reminder ? (
                      <>
                        <span className="block">{note.reminder.description}</span>
                        <span className="text-faint">
                          {note.reminder.nextFireAt ? U.next(formatDateTime(note.reminder.nextFireAt)) : U.noNext}
                        </span>
                      </>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {U.loadMore}
          </Button>
        </div>
      )}

      {(noteId || isNew) && (
        <NoteModal
          noteId={noteId}
          defaults={{ noteDate: newDate, entity: entity ?? entityFilter ?? null }}
          onClose={() => setParams({ note: null, new: null })}
          onSaved={() => {
            saved();
            setParams({ note: null, new: null });
          }}
          onChanged={saved}
        />
      )}
    </div>
  );
}
