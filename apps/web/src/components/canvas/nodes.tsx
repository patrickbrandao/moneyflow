import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Boxes, Layers, Radio } from 'lucide-react';
import { memo } from 'react';
import { Badge, TileIcon } from '../ui';
import { type EntryNode, type GroupNode, type HubNode, type ItemNode, inHandle, outHandle, PORTS, type PortId, portStyle } from './types';

/*
 * Os quatro tipos de nó. `memo` é obrigatório: sem ele, arrastar um nó
 * re-renderiza todos os outros. Nenhum nó faz fetch — tudo chega por `data`,
 * montado no nível do palco.
 */

function HubNodeImpl({ data, selected }: NodeProps<HubNode>) {
  return (
    <div className={`node-hub${selected ? ' selected' : ''}${data.isActive ? '' : ' off'}`}>
      <Handle type="target" position={Position.Left} id="in" className="in-handle" isConnectable={false} />
      <div className="hd">
        <span className="node-ic">
          <Boxes />
        </span>
        <span className="min-w-0 flex-1">
          <span className="nm">{data.title}</span>
          <span className="sl">{data.subtitle}</span>
        </span>
      </div>
      {data.badges.length > 0 && (
        <div className="st">
          {data.badges.map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </div>
      )}
      <div className="ports">
        {PORTS.map((port) => (
          <div key={port.id} className="port" style={portStyle(port.id)}>
            <span className="pd" />
            <span className="pl">{port.label}</span>
            <span className="pc">{data.counts?.[port.id] ?? 0}</span>
            <Handle type="source" position={Position.Right} id={outHandle(port.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Um handle de entrada por porta, na ordem das portas do hub: cheio quando ligado. */
function InHandles({ ports }: { ports: PortId[] | undefined }) {
  return (
    <>
      {PORTS.map((port, index) => (
        <Handle
          key={port.id}
          type="target"
          position={Position.Left}
          id={inHandle(port.id)}
          className={ports?.includes(port.id) ? 'on' : undefined}
          style={portStyle(port.id, { top: `${((index + 1) / (PORTS.length + 1)) * 100}%` })}
          title={port.label}
        />
      ))}
    </>
  );
}

function ItemNodeImpl({ data, selected }: NodeProps<ItemNode>) {
  return (
    <div className={`node-item${selected ? ' selected' : ''}${data.isActive ? '' : ' off'}`} title={data.title}>
      <InHandles ports={data.ports} />
      <TileIcon icon={data.icon} name={data.title} />
      <span className="tx">
        <span className="nm">{data.title}</span>
        <span className="sl">{data.subtitle}</span>
      </span>
      {data.busy && <span className="busy" aria-label="salvando" />}
    </div>
  );
}

function GroupNodeImpl({ data, selected }: NodeProps<GroupNode>) {
  const empty = data.count === 0;
  return (
    <div className={`node-item node-group${selected ? ' selected' : ''}${data.isActive ? '' : ' off'}`} title={data.title}>
      <InHandles ports={data.ports} />
      <span className="node-ic">
        <Layers />
      </span>
      <span className="tx">
        <span className="nm">{data.title}</span>
        <span className="sl">{data.subtitle}</span>
      </span>
      <span className={`cnt${empty ? ' zero' : ''}`}>
        <b>{data.count}</b>
        <small>{data.count === 1 ? data.countLabel[0] : data.countLabel[1]}</small>
      </span>
      {data.busy && <span className="busy" aria-label="salvando" />}
    </div>
  );
}

function EntryNodeImpl({ data, selected }: NodeProps<EntryNode>) {
  return (
    <div className={`node-entry${data.live > 0 ? ' live' : ''}${selected ? ' selected' : ''}`}>
      <div className="globe">
        <Radio />
        <Handle type="source" position={Position.Right} id="out" isConnectable={false} />
      </div>
      <span className="lb">{data.label}</span>
    </div>
  );
}

/**
 * Declarados fora de qualquer componente: dentro, remontariam todos os nós a
 * cada render. NÃO use as chaves `group`, `default`, `input` ou `output`: são
 * tipos nativos do React Flow e o wrapper `.react-flow__node-<tipo>` traz
 * fundo, borda e padding próprios (por isso o grupo aqui se chama `cluster`).
 */
export const nodeTypes = {
  hub: memo(HubNodeImpl),
  item: memo(ItemNodeImpl),
  cluster: memo(GroupNodeImpl),
  entry: memo(EntryNodeImpl),
};
