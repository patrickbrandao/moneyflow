import { t } from '@moneyflow/shared';
import { ArrowLeftRight, Building2, LogOut, Moon, UserRound, Wallet } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { AgentsProvider } from './agents/AgentsProvider';
import { Layout } from './components/shell/Layout';
import { SessionExpiredDialog } from './components/shell/SessionExpiredDialog';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ui';
import { BRAND } from './config/brand';
import { useAuth } from './lib/auth';
import { CommandProvider, useRegisterCommands } from './lib/commands';
import { lazyNamed } from './lib/lazy';
import { toggleTheme } from './lib/theme';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';

/*
 * Telas sob demanda (tarefa 128): o arquivo principal leva só a casca, o login
 * e a visão geral; cada outra tela (o canvas, a administração de IA, os
 * contratos…) é um pedaço próprio, baixado na primeira visita. O Suspense fica
 * no `Layout`, em volta do conteúdo: a casca não pisca ao trocar de tela.
 */
const AccountPage = lazyNamed(() => import('./pages/AccountPage'), 'AccountPage');
const AdminAiPage = lazyNamed(() => import('./pages/AdminAiPage'), 'AdminAiPage');
const AdminAiProviderPage = lazyNamed(() => import('./pages/AdminAiProviderPage'), 'AdminAiProviderPage');
const AdminBackupPage = lazyNamed(() => import('./pages/AdminBackupPage'), 'AdminBackupPage');
const AdminMcpPage = lazyNamed(() => import('./pages/AdminMcpPage'), 'AdminMcpPage');
const AuditPage = lazyNamed(() => import('./pages/AuditPage'), 'AuditPage');
const CaixaPage = lazyNamed(() => import('./pages/CaixaPage'), 'CaixaPage');
const CaixasPage = lazyNamed(() => import('./pages/CaixasPage'), 'CaixasPage');
const CalendarPage = lazyNamed(() => import('./pages/CalendarPage'), 'CalendarPage');
const CategoriesPage = lazyNamed(() => import('./pages/CategoriesPage'), 'CategoriesPage');
const ContractPage = lazyNamed(() => import('./pages/ContractPage'), 'ContractPage');
const ContractsPage = lazyNamed(() => import('./pages/ContractsPage'), 'ContractsPage');
const EntitiesPage = lazyNamed(() => import('./pages/EntitiesPage'), 'EntitiesPage');
const EntityPage = lazyNamed(() => import('./pages/EntityPage'), 'EntityPage');
const FinancialAccountPage = lazyNamed(() => import('./pages/FinancialAccountPage'), 'FinancialAccountPage');
const FlowPage = lazyNamed(() => import('./pages/FlowPage'), 'FlowPage');
const InvoicePage = lazyNamed(() => import('./pages/InvoicePage'), 'InvoicePage');
const MessagesPage = lazyNamed(() => import('./pages/MessagesPage'), 'MessagesPage');
const NotesPage = lazyNamed(() => import('./pages/NotesPage'), 'NotesPage');
const ReconcileRecipesPage = lazyNamed(() => import('./pages/ReconcileRecipesPage'), 'ReconcileRecipesPage');
const ReportsPage = lazyNamed(() => import('./pages/ReportsPage'), 'ReportsPage');
const TransfersPage = lazyNamed(() => import('./pages/TransfersPage'), 'TransfersPage');
const UsersPage = lazyNamed(() => import('./pages/UsersPage'), 'UsersPage');

export default function App() {
  const { user, ready, expired } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = BRAND.name;
  }, []);

  // Outro usuário entrou pela janela da sessão expirada: o console recomeça (key) na página inicial.
  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!user) return;
    if (lastUserId.current && lastUserId.current !== user.id) navigate('/', { replace: true });
    lastUserId.current = user.id;
  }, [user, navigate]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        {user ? (
          <>
            {/* A sessão que cai não desmonta o console (tarefa 119): a janela de login fica por cima. */}
            <Console key={user.id} />
            {expired && <SessionExpiredDialog />}
          </>
        ) : (
          <LoginPage />
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}

/** Tudo que existe só com sessão: comandos globais, shell e rotas. */
function Console() {
  return (
    <CommandProvider>
      <GlobalCommands />
      {/* Janelas dos agentes: acima das rotas, para sobreviver à navegação. */}
      <AgentsProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<OverviewPage />} />
            <Route path="caixas" element={<CaixasPage />} />
            <Route path="caixas/:id" element={<CaixaPage />} />
            <Route path="caixas/:id/:tab" element={<CaixaPage />} />
            <Route path="caixas/:id/accounts/:accountId" element={<FinancialAccountPage />} />
            <Route path="caixas/:id/accounts/:accountId/:tab" element={<FinancialAccountPage />} />
            <Route path="entities" element={<EntitiesPage />} />
            <Route path="entities/:id" element={<EntityPage />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="contracts" element={<ContractsPage />} />
            <Route path="contracts/:id" element={<ContractPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="reconcile-recipes" element={<ReconcileRecipesPage />} />
            <Route path="card-invoices/:id" element={<InvoicePage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:tab" element={<ReportsPage />} />
            <Route path="messages" element={<MessagesPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="admin/ai" element={<AdminAiPage />} />
            <Route path="admin/ai/providers/:id" element={<AdminAiProviderPage />} />
            <Route path="admin/ai/:tab" element={<AdminAiPage />} />
            <Route path="admin/backup" element={<AdminBackupPage />} />
            <Route path="admin/backup/:tab" element={<AdminBackupPage />} />
            <Route path="admin/mcp" element={<AdminMcpPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route element={<Layout stage />}>
            <Route path="flow" element={<FlowPage />} />
          </Route>
        </Routes>
      </AgentsProvider>
    </CommandProvider>
  );
}

/** Comandos que valem em qualquer tela (as telas registram os delas). */
function GlobalCommands() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  useRegisterCommands(
    [
      {
        id: 'new-entity',
        label: t.palette.newEntity,
        group: 'Criar',
        icon: <Building2 />,
        keywords: ['pessoa', 'empresa', 'cnpj', 'cpf'],
        run: () => navigate('/entities?new=1'),
      },
      { id: 'new-caixa', label: t.palette.newCaixa, group: 'Criar', icon: <Wallet />, run: () => navigate('/caixas?new=1') },
      {
        id: 'new-transfer',
        label: t.palette.newTransfer,
        group: 'Criar',
        icon: <ArrowLeftRight />,
        run: () => navigate('/transfers?new=1'),
      },
      {
        id: 'theme',
        label: t.palette.toggleTheme,
        group: 'Conta',
        icon: <Moon />,
        keywords: ['dark', 'light', 'escuro', 'claro'],
        run: toggleTheme,
      },
      { id: 'account', label: t.nav.account, group: 'Conta', icon: <UserRound />, run: () => navigate('/account') },
      { id: 'logout', label: t.palette.logout, group: 'Conta', icon: <LogOut />, run: () => void logout() },
    ],
    [logout, navigate],
  );
  return null;
}
