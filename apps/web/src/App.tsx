import { t } from '@moneyflow/shared';
import { ArrowLeftRight, Building2, LogOut, Moon, UserRound, Wallet } from 'lucide-react';
import { useEffect } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { Layout } from './components/shell/Layout';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ui';
import { BRAND } from './config/brand';
import { useAuth } from './lib/auth';
import { CommandProvider, useRegisterCommands } from './lib/commands';
import { toggleTheme } from './lib/theme';
import { AccountPage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';
import { CaixaPage } from './pages/CaixaPage';
import { CaixasPage } from './pages/CaixasPage';
import { CalendarPage } from './pages/CalendarPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { EntitiesPage } from './pages/EntitiesPage';
import { EntityPage } from './pages/EntityPage';
import { InvoicePage } from './pages/InvoicePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { TransfersPage } from './pages/TransfersPage';
import { UsersPage } from './pages/UsersPage';

export default function App() {
  const { user, ready, notice } = useAuth();

  useEffect(() => {
    document.title = BRAND.name;
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>{user ? <Console /> : <LoginPage notice={notice} />}</ConfirmProvider>
    </ToastProvider>
  );
}

/** Tudo que existe só com sessão: comandos globais, shell e rotas. */
function Console() {
  return (
    <CommandProvider>
      <GlobalCommands />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="caixas" element={<CaixasPage />} />
          <Route path="caixas/:id" element={<CaixaPage />} />
          <Route path="caixas/:id/:tab" element={<CaixaPage />} />
          <Route path="entities" element={<EntitiesPage />} />
          <Route path="entities/:id" element={<EntityPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="card-invoices/:id" element={<InvoicePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
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
