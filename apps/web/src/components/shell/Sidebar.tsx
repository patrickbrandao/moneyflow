import { ChevronDown, ExternalLink, MoreVertical, PanelLeftClose } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { BRAND } from '../../config/brand';
import { type NavGroup, type NavLink as NavLinkDef, navigationFor } from '../../config/navigation';
import { ROLE_LABEL, useUser } from '../../lib/auth';
import { Avatar, type MenuTrigger } from '../ui';
import { UserMenu } from './UserMenu';

/** Mesma quebra do CSS: abaixo dela a sidebar é gaveta, não coluna. */
export const NARROW = '(max-width: 900px)';

const linkClass = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`;

function Item({ link }: { link: NavLinkDef }) {
  return (
    <NavLink to={link.to} end={link.end} className={linkClass}>
      {link.icon} {link.label}
    </NavLink>
  );
}

/** Grupo recolhível: abre sozinho quando a rota atual é de um filho. */
function Group({ group }: { group: NavGroup }) {
  const location = useLocation();
  const inside = group.children.some((child) => location.pathname === child.to || location.pathname.startsWith(`${child.to}/`));
  const [open, setOpen] = useState(inside);
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside]);

  return (
    <>
      <button type="button" className={`nav-item${inside ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {group.icon} {group.label}
        <ChevronDown className="chev" />
      </button>
      {open && (
        <div className="nav-sub">
          {group.children.map((child) => (
            <Item key={child.to} link={child} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * A sidebar: a marca (logo + título) com o botão de recolher, a navegação em
 * seções separadas por fio e, no rodapé, a conta com o seu menu. Acima de
 * 900px ela recolhe para a esquerda; abaixo, vira gaveta e o mesmo botão a fecha.
 */
export function Sidebar({ open, onClose, onCollapse }: { open: boolean; onClose: () => void; onCollapse: () => void }) {
  const user = useUser();
  const location = useLocation();
  const sections = navigationFor(user.role);

  // Fecha a gaveta ao navegar (só importa no mobile).
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // O rodapé inteiro é o botão: avatar, nome, papel e o ⋮ abrem o mesmo menu.
  const accountTrigger: MenuTrigger = (props) => (
    <button type="button" className="sidebar-account" title={`@${user.username}`} {...props}>
      <Avatar name={user.name} src={user.avatarUrl} />
      <span className="min-w-0 flex-1">
        <span className="nm">{user.name}</span>
        <span className="role">{ROLE_LABEL[user.role]}</span>
      </span>
      <MoreVertical className="more" />
    </button>
  );

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar-inner">
        <div className="sidebar-head">
          <Link to={BRAND.homePath} className="sidebar-brand">
            <img src={BRAND.logoUrl} alt="" />
            <span className="nm">{BRAND.name}</span>
          </Link>
          <button
            type="button"
            className="icon-btn sidebar-collapse"
            title="Recolher o menu"
            aria-label="Recolher o menu"
            onClick={() => (window.matchMedia(NARROW).matches ? onClose() : onCollapse())}
          >
            <PanelLeftClose />
          </button>
        </div>

        <nav className="nav" aria-label="Principal">
          {sections.map((section, index) => (
            <div key={index} className="contents">
              {index > 0 && <div className="nav-sep" />}
              {section.map((entry) => {
                if (entry.kind === 'link') return <Item key={entry.to} link={entry} />;
                if (entry.kind === 'group') return <Group key={entry.id} group={entry} />;
                return (
                  <a key={entry.href} className="nav-item ext" href={entry.href} target="_blank" rel="noreferrer">
                    {entry.icon} {entry.label} <ExternalLink className="out" />
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <UserMenu trigger={accountTrigger} up className="sidebar-foot" />
      </div>
    </aside>
  );
}
