import { formatAccounting, t } from '@moneyflow/shared';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Building2, CreditCard, Layers, UserRound, Wallet } from 'lucide-react';
import { type CSSProperties, memo } from 'react';
import { negClass } from '../domain';
import { cx } from '../ui';
import type { CaixaFlowNode, ClusterFlowNode, EntityFlowNode } from './graph';

/*
 * Os nós do canvas de fluxo. `memo` é obrigatório (arrastar um nó não
 * re-renderiza os outros) e nenhum nó busca dado: tudo chega por `data`.
 * Entrada à esquerda (handle "in"), saída à direita ("out").
 */

const Handles = ({ vertical }: { vertical?: boolean }) => (
  <>
    <Handle type="target" position={Position.Left} id="in" isConnectable={false} className="flow-handle" />
    <Handle type="source" position={Position.Right} id="out" isConnectable={false} className="flow-handle" />
    {vertical && (
      <>
        {/* Entre caixas da mesma coluna (transferência, espelho), a aresta sai por baixo/cima. */}
        <Handle type="source" position={Position.Bottom} id="out-b" isConnectable={false} className="flow-handle" />
        <Handle type="target" position={Position.Top} id="in-t" isConnectable={false} className="flow-handle" />
        <Handle type="source" position={Position.Top} id="out-t" isConnectable={false} className="flow-handle is-hidden" />
        <Handle type="target" position={Position.Bottom} id="in-b" isConnectable={false} className="flow-handle is-hidden" />
      </>
    )}
  </>
);

function CaixaNodeImpl({ data, selected }: NodeProps<CaixaFlowNode>) {
  const ref = data.ref;
  const used = ref.cardUsedCents ?? 0;
  const limit = ref.cardLimitCents ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used * 100) / limit)) : 0;
  return (
    <div className={cx('node-hub flow-caixa', selected && 'selected', data.dim && 'is-dim')}>
      <Handles vertical />
      <div className="hd">
        <span className="node-ic">{data.isCard ? <CreditCard /> : <Wallet />}</span>
        <span className="min-w-0 flex-1">
          <span className="nm">{data.name}</span>
          <span className="sl">{data.isCard ? t.flow.cardNode : t.flow.caixaNode}</span>
        </span>
      </div>
      {data.isCard ? (
        <div className="flow-meter" title={`${t.flow.cardUsed}: ${formatAccounting(used)} / ${formatAccounting(limit)}`}>
          <div className="flow-meter-row">
            <span>{t.flow.cardUsed}</span>
            <b className={cx('money', negClass(used))}>{formatAccounting(used)}</b>
          </div>
          <div className="flow-bar" aria-hidden>
            <i style={{ width: `${percent}%` }} className={percent >= 100 ? 'over' : percent >= 80 ? 'high' : ''} />
          </div>
        </div>
      ) : (
        <div className="flow-balance">
          <span>{t.flow.balance}</span>
          <b className={cx('money', negClass(ref.balanceCents))}>{formatAccounting(ref.balanceCents ?? 0)}</b>
        </div>
      )}
      <div className="flow-io">
        <span className="in">
          ↓ <span className={cx('money', negClass(data.inCents))}>{formatAccounting(data.inCents)}</span>
        </span>
        <span className="out">
          ↑ <span className={cx('money', negClass(data.outCents))}>{formatAccounting(data.outCents)}</span>
        </span>
      </div>
    </div>
  );
}

const slotStyle = (slot: number | null) => (slot ? { '--port': `var(--port-${slot})` } : undefined) as CSSProperties | undefined;

function EntityNodeImpl({ data, selected }: NodeProps<EntityFlowNode>) {
  const value = data.side === 'left' ? data.outCents : data.inCents;
  return (
    <div
      className={cx('node-item flow-entity', selected && 'selected', data.dim && 'is-dim')}
      title={data.name}
      style={slotStyle(data.colorSlot)}
    >
      <Handles />
      <span className="node-ic">{data.ref.entityKind === 'company' ? <Building2 /> : <UserRound />}</span>
      <span className="tx">
        <span className="nm">{data.name}</span>
        <span className="sl">
          <i className="flow-dot" aria-hidden />
          {data.groupName ?? (data.ref.holderEntityId ? t.flow.outside : t.flow.entityNode)}
        </span>
      </span>
      <span className={cx('flow-amt money', negClass(value))}>{formatAccounting(value)}</span>
    </div>
  );
}

function ClusterNodeImpl({ data, selected }: NodeProps<ClusterFlowNode>) {
  const value = data.side === 'left' ? data.outCents : data.inCents;
  return (
    <div
      className={cx('node-item node-group flow-entity', selected && 'selected', data.dim && 'is-dim')}
      title={t.flow.groupOf(data.name || t.flow.otherGroup)}
      style={slotStyle(data.colorSlot)}
    >
      <Handles />
      <span className="node-ic">
        <Layers />
      </span>
      <span className="tx">
        <span className="nm">{data.name || t.flow.otherGroup}</span>
        <span className="sl">
          <i className="flow-dot" aria-hidden />
          {formatAccounting(value)}
        </span>
      </span>
      <span className="cnt">
        <b>{data.entityIds.length}</b>
        <small>{t.flow.entityWord(data.entityIds.length)}</small>
      </span>
    </div>
  );
}

/** Fora de qualquer componente (dentro, remontaria tudo a cada render). Nada de `group`/`default`: são tipos nativos. */
export const flowNodeTypes = {
  caixa: memo(CaixaNodeImpl),
  entity: memo(EntityNodeImpl),
  cluster: memo(ClusterNodeImpl),
};
