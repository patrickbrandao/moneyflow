import { Boxes, Crosshair, Layers, Radio, Settings, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button, ButtonLink, TileIcon } from '../ui';
import { type CanvasNode, isLeaf, PORTS, type PortId } from './types';

/**
 * A gaveta à direita do palco: o detalhe do nó selecionado, sem tirar o canvas
 * da tela. Anatomia fixa: cabeçalho (ícone + título + fechar), subtítulo em
 * mono, selos, descrição e seções com `.eyebrow` — caixas de porta em `.well`,
 * pares chave/valor em `<dl className="kv">`, ações no fim.
 */
export function NodeDrawer({
  node,
  connections,
  canEdit,
  settingsTo,
  onClose,
  onTogglePort,
  onRemove,
  onFocus,
}: {
  node: CanvasNode | null;
  /** Quantas arestas tocam o nó. */
  connections: number;
  canEdit: boolean;
  /** Para onde "Configurações" do hub leva. */
  settingsTo?: string;
  onClose: () => void;
  onTogglePort: (nodeId: string, port: PortId, on: boolean) => void;
  onRemove: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
}) {
  if (!node) return null;

  const head = (icon: ReactNode, title: string) => (
    <div className="dh">
      {icon}
      <span className="t">{title}</span>
      <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)" aria-label="Fechar">
        <X />
      </button>
    </div>
  );

  const position = (
    <>
      <dt>Posição</dt>
      <dd className="mono">
        {Math.round(node.position.x)}, {Math.round(node.position.y)}
      </dd>
    </>
  );

  if (isLeaf(node)) {
    const data = node.data;
    const ports = data.ports ?? [];
    return (
      <aside className="drawer" aria-label={data.title}>
        {head(
          node.type === 'cluster' ? (
            <Layers size={18} style={{ color: 'var(--accent-soft)' }} />
          ) : (
            <TileIcon icon={data.icon} name={data.title} size="sm" />
          ),
          data.title,
        )}
        <div className="db">
          <p className="mono text-xs text-faint">{data.subtitle}</p>
          {!data.isActive && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="danger">desligado</Badge>
            </div>
          )}
          <p className="mt-2 text-[13px] text-dim">{data.description || 'Sem descrição.'}</p>

          <div className="sec">
            <p className="eyebrow">Portas ligadas</p>
            <div className="grid gap-2">
              {PORTS.map((port) => (
                <label key={port.id} className="check well">
                  <input
                    type="checkbox"
                    checked={ports.includes(port.id)}
                    disabled={!canEdit || data.busy}
                    onChange={(event) => onTogglePort(node.id, port.id, event.target.checked)}
                  />
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: port.color }} />
                  {port.label}
                </label>
              ))}
            </div>
            <p className="hint">Marcar liga a porta do hub a este nó; desmarcar remove a ligação.</p>
          </div>

          <div className="sec">
            <p className="eyebrow">Detalhes</p>
            <dl className="kv">
              <dt>Tipo</dt>
              <dd>{node.type === 'cluster' ? 'Grupo' : 'Item'}</dd>
              {node.type === 'cluster' && (
                <>
                  <dt>Membros</dt>
                  <dd>
                    <strong>{node.data.count}</strong>
                  </dd>
                </>
              )}
              <dt>Ligações</dt>
              <dd>{connections}</dd>
              {Object.entries(data.meta ?? {}).map(([key, value]) => (
                <span key={key} className="contents">
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </span>
              ))}
              <dt>ID</dt>
              <dd className="mono">{node.id}</dd>
              {position}
            </dl>
          </div>

          <div className="sec flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => onFocus(node.id)}>
              <Crosshair /> Centralizar
            </Button>
            {canEdit && (
              <Button variant="danger" size="sm" disabled={data.busy} onClick={() => onRemove(node.id)}>
                <Trash2 /> Remover do fluxo
              </Button>
            )}
          </div>
        </div>
      </aside>
    );
  }

  if (node.type === 'entry') {
    const data = node.data;
    return (
      <aside className="drawer" aria-label={data.label}>
        {head(<Radio size={18} style={{ color: data.live > 0 ? 'var(--ok)' : 'var(--text-muted)' }} />, data.label)}
        <div className="db">
          <p className="text-[13px] text-dim">{data.description || 'Origem do que chega ao hub.'}</p>
          <div className="sec">
            <p className="eyebrow">Agora</p>
            <dl className="kv">
              <dt>Conexões ativas</dt>
              <dd>
                <strong>{data.live}</strong>
              </dd>
              {position}
            </dl>
          </div>
        </div>
      </aside>
    );
  }

  const data = node.data;
  return (
    <aside className="drawer" aria-label={data.title}>
      {head(<Boxes size={18} style={{ color: 'var(--accent-soft)' }} />, data.title)}
      <div className="db">
        <p className="mono text-xs text-faint">{data.subtitle}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.badges.map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-dim">{data.description || 'Sem descrição.'}</p>
        <div className="sec">
          <p className="eyebrow">Portas</p>
          <dl className="kv">
            {PORTS.map((port) => (
              <span key={port.id} className="contents">
                <dt>{port.label}</dt>
                <dd>
                  {data.counts?.[port.id] ?? 0} ligaç{(data.counts?.[port.id] ?? 0) === 1 ? 'ão' : 'ões'}
                </dd>
              </span>
            ))}
            {position}
          </dl>
        </div>
        {settingsTo && (
          <div className="sec flex flex-wrap gap-2">
            <ButtonLink to={settingsTo} size="sm">
              <Settings /> Configurações
            </ButtonLink>
          </div>
        )}
      </div>
    </aside>
  );
}
