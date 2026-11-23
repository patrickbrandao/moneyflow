import { t } from '@moneyflow/shared';
import { LogOut, Moon, Sun, UserRound } from 'lucide-react';

import { useAuth, useUser } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { Menu, MenuHeading, MenuItem, MenuSeparator, type MenuTrigger } from '../ui';

/** O menu da conta, aberto pelo rodapé da sidebar (abre para cima). */
export function UserMenu({ trigger, up, className }: { trigger: MenuTrigger; up?: boolean; className?: string }) {
  const user = useUser();
  const { logout } = useAuth();
  const [theme, toggleTheme] = useTheme();

  return (
    <Menu trigger={trigger} up={up} className={className}>
      <MenuHeading>@{user.username}</MenuHeading>
      <MenuItem to="/account" icon={<UserRound />}>
        {t.nav.account}
      </MenuItem>
      <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? <Sun /> : <Moon />}>
        {theme === 'dark' ? t.shell.themeLight : t.shell.themeDark}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void logout()} icon={<LogOut />}>
        {t.auth.logout}
      </MenuItem>
    </Menu>
  );
}
