import { BACKUP_RESOURCES, type BackupResource, type BackupStatus, t } from '@moneyflow/shared';
import { ArchiveRestore, Bot, Building2, DatabaseBackup, Tags, Users, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BackupTab, ResourceTab, RestoreTab } from '../components/backup/tabs';
import { PageHead } from '../components/domain';
import { Tabs } from '../components/ui';
import { useUser } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { NotFoundPage } from './NotFoundPage';

const b = t.backup;
const TABS = [...BACKUP_RESOURCES, 'backup', 'restore'] as const;
type Tab = (typeof TABS)[number];

const ICONS: Record<Tab, ReactNode> = {
  categories: <Tags />,
  entities: <Building2 />,
  caixas: <Wallet />,
  'ai-providers': <Bot />,
  users: <Users />,
  backup: <DatabaseBackup />,
  restore: <ArchiveRestore />,
};

/** Administração → Backup e restauração (spec 019, só admin): exportar/importar cadastros, backup completo e restauração. */
export function AdminBackupPage() {
  const user = useUser();
  const { tab: raw } = useParams();
  const navigate = useNavigate();
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'categories';
  const status = useApi<BackupStatus>(user.role === 'admin' ? '/api/backup/status' : null);
  if (user.role !== 'admin') return <NotFoundPage />;

  return (
    <div className="page wide">
      <PageHead title={b.title} sub={b.sub} />
      <Tabs
        value={tab}
        onChange={(key) => navigate(key === 'categories' ? '/admin/backup' : `/admin/backup/${key}`)}
        items={TABS.map((key) => ({ key, label: b.tabs[key]!, icon: ICONS[key] }))}
      />
      {(BACKUP_RESOURCES as readonly string[]).includes(tab) && <ResourceTab key={tab} resource={tab as BackupResource} />}
      {tab === 'backup' && <BackupTab status={status.data} />}
      {tab === 'restore' && <RestoreTab status={status.data} />}
    </div>
  );
}
