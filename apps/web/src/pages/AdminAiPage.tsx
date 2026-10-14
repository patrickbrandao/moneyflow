import { t } from '@moneyflow/shared';
import { BarChart3, Bot, CalendarClock, CircleDollarSign, Plug, Radio, Server, Wrench } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { AgentsTab } from '../components/admin-ai/AgentsTab';
import { AutonomousTab } from '../components/admin-ai/AutonomousTab';
import { McpTab } from '../components/admin-ai/McpTab';
import { PricesTab } from '../components/admin-ai/PricesTab';
import { ProvidersTab } from '../components/admin-ai/ProvidersTab';
import { RequestsTab } from '../components/admin-ai/RequestsTab';
import { ToolKitsTab } from '../components/admin-ai/ToolKitsTab';
import { UsageTab } from '../components/admin-ai/UsageTab';
import { PageHead } from '../components/domain';
import { Tabs } from '../components/ui';
import { useUser } from '../lib/auth';
import { NotFoundPage } from './NotFoundPage';

const a = t.agentsUi.admin;
const TABS = ['providers', 'prices', 'agents', 'tool-kits', 'mcp', 'usage', 'requests', 'autonomous'] as const;
type Tab = (typeof TABS)[number];

/** Administração da IA (spec 011, só admin): provedores, preços, agentes, kits de ferramentas (spec 021), servidores MCP, uso, requisições (spec 023) e as tarefas agendadas e o Telegram de entrada (spec 029). */
export function AdminAiPage() {
  const user = useUser();
  const { tab: raw } = useParams();
  const navigate = useNavigate();
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'providers';
  if (user.role !== 'admin') return <NotFoundPage />;

  return (
    <div className="page wide">
      <PageHead title={a.title} sub={a.sub} />
      <Tabs
        value={tab}
        onChange={(key) => navigate(key === 'providers' ? '/admin/ai' : `/admin/ai/${key}`)}
        items={[
          { key: 'providers', label: a.tabs.providers, icon: <Server /> },
          { key: 'prices', label: a.tabs.prices, icon: <CircleDollarSign /> },
          { key: 'agents', label: a.tabs.agents, icon: <Bot /> },
          { key: 'tool-kits', label: a.tabs.toolKits, icon: <Wrench /> },
          { key: 'mcp', label: a.tabs.mcp, icon: <Plug /> },
          { key: 'usage', label: a.tabs.usage, icon: <BarChart3 /> },
          { key: 'requests', label: a.tabs.requests, icon: <Radio /> },
          { key: 'autonomous', label: a.tabs.autonomous, icon: <CalendarClock /> },
        ]}
      />
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'prices' && <PricesTab />}
      {tab === 'agents' && <AgentsTab />}
      {tab === 'tool-kits' && <ToolKitsTab />}
      {tab === 'mcp' && <McpTab />}
      {tab === 'usage' && <UsageTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'autonomous' && <AutonomousTab />}
    </div>
  );
}
