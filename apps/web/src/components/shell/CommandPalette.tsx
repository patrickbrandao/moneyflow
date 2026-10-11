import { t } from '@moneyflow/shared';
import { Command } from 'cmdk';
import { CornerDownLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { flatLinks, navigationFor } from '../../config/navigation';
import { SEARCH_SOURCES, type SearchResult } from '../../config/search';
import { useUser } from '../../lib/auth';
import { type Command as Cmd, fuzzyScore, GROUP_ORDER, useCommandRegistry } from '../../lib/commands';
import { Kbd, useDebounced } from '../ui';

/**
 * A paleta (⌘K): busca nas fontes de `config/search.tsx`, lista as telas da
 * navegação ("Ir para") e os comandos registrados pela tela atual. A
 * filtragem é nossa (`fuzzyScore`, `shouldFilter={false}`) porque parte dos
 * itens já chega filtrada da fonte.
 */
export function CommandPalette() {
  const { commands, isOpen, close } = useCommandRegistry();
  const navigate = useNavigate();
  const user = useUser();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 200);
  const [results, setResults] = useState<Record<string, SearchResult[]>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) setSearch('');
  }, [isOpen]);

  // Cada abertura e cada busca consultam as fontes de novo; a resposta
  // atrasada de uma busca antiga não pinta por cima da nova.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const q = debounced.trim();
    setLoading(true);
    Promise.all(
      SEARCH_SOURCES.map(
        async (source) => [source.id, q.length >= source.minChars ? await source.search(q, 6).catch(() => []) : []] as const,
      ),
    )
      .then((entries) => {
        if (!cancelled) setResults(Object.fromEntries(entries));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, debounced]);

  // "Ir para" sai da navegação; os comandos registrados vêm agrupados.
  const grouped = useMemo(() => {
    const q = search.trim();
    const goto: Cmd[] = flatLinks(navigationFor(user.role)).map(({ link, group }) => ({
      id: `goto:${link.to}`,
      label: group ? `${group.label} › ${link.label}` : link.label,
      group: 'Ir para',
      icon: link.icon,
      shortcut: link.shortcut,
      run: () => navigate(link.to),
    }));
    const scored = [...commands, ...goto]
      .map((command) => ({ command, score: fuzzyScore(q, `${command.label} ${(command.keywords ?? []).join(' ')}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    const byGroup = new Map<string, Cmd[]>();
    for (const { command } of scored) byGroup.set(command.group, [...(byGroup.get(command.group) ?? []), command]);
    return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({ group, items: byGroup.get(group)! }));
  }, [commands, search, user.role, navigate]);

  function run(action: () => void | Promise<void>) {
    close();
    void action();
  }

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      label="Paleta de comandos"
      shouldFilter={false}
      loop
      overlayClassName="overlay"
      contentClassName="palette"
    >
      <Command.Input value={search} onValueChange={setSearch} placeholder={t.palette.placeholder} autoFocus />
      <div className="trail">
        <span>Digite para filtrar</span>
        <span className="hint-k">
          <span>
            <Kbd>↑↓</Kbd> navegar
          </span>
          <span>
            <Kbd>↵</Kbd> abrir
          </span>
          <span>
            <Kbd>esc</Kbd> fechar
          </span>
        </span>
      </div>
      <Command.List>
        <Command.Empty>{loading ? 'Buscando…' : 'Nada encontrado.'}</Command.Empty>

        {SEARCH_SOURCES.map((source) => {
          const items = results[source.id] ?? [];
          if (items.length === 0) return null;
          return (
            <Command.Group key={source.id} heading={source.heading}>
              {items.map((item) => (
                <Command.Item key={item.id} value={`${source.id}:${item.id}`} onSelect={() => run(() => navigate(item.to))}>
                  {item.icon ?? source.icon}
                  <span className="lbl">{item.label}</span>
                  {item.sub && <span className="sub">{item.sub}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}

        {grouped.map(({ group, items }) => (
          <Command.Group key={group} heading={group}>
            {items.map((command) => (
              <Command.Item
                key={command.id}
                value={`cmd:${command.id}`}
                disabled={Boolean(command.disabled)}
                className={command.danger ? 'danger' : undefined}
                onSelect={() => {
                  if (!command.disabled) run(command.run);
                }}
              >
                {command.icon ?? <CornerDownLeft />}
                <span className="lbl">{command.label}</span>
                {command.disabled && <span className="sub">{command.disabled}</span>}
                {command.shortcut && !command.disabled && (
                  <span className="sc">
                    {command.shortcut.split(' ').map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
