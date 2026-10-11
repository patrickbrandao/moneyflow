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
        Minha conta
      </MenuItem>
      <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? <Sun /> : <Moon />}>
        {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void logout()} icon={<LogOut />}>
        Sair
      </MenuItem>
    </Menu>
  );
}
