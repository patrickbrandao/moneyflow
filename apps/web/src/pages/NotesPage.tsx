import { t } from '@moneyflow/shared';
import { NotebookPen } from 'lucide-react';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { PageHead } from '../components/domain';
import { NotesBrowser } from '../components/notes/NotesBrowser';
import { useRegisterCommands } from '../lib/commands';
import { useSetParams } from '../lib/params';

/** Anotações (spec 035): calendário anual e mensal com as bolinhas por tipo e a tabela com os filtros. */
export function NotesPage() {
  const setParams = useSetParams();
  useAgentScreenContext({ title: t.notes.title });
  useRegisterCommands(
    [{ id: 'note-new', label: t.palette.newNote, group: 'Criar', icon: <NotebookPen />, run: () => setParams({ new: '1', note: null }) }],
    [setParams],
  );
  return (
    <div className="page wide">
      <PageHead title={t.notes.title} sub={t.notes.ui.pageSub} />
      <NotesBrowser withCalendar />
    </div>
  );
}
