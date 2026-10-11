import { type FormEvent, useState } from 'react';
import { Button, Field, Modal } from '../ui';
import { PORTS, type PortId } from './types';

export type NewLeaf = { kind: 'item' | 'group'; title: string; icon: string; ports: PortId[] };

/**
 * Diálogo de "Adicionar nó": nome, tipo, ícone e as portas que já nascem
 * ligadas. Montado com `key` pelo palco, para reabrir limpo.
 */
export function AddNodeDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (leaf: NewLeaf) => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NewLeaf['kind']>('item');
  const [icon, setIcon] = useState('');
  const [ports, setPorts] = useState<PortId[]>([PORTS[0]!.id]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    onConfirm({ kind, title: title.trim(), icon: icon.trim(), ports });
  }

  return (
    <Modal open={open} title="Adicionar nó" onClose={onClose}>
      <form onSubmit={submit} className="mt-4 grid gap-4">
        <Field label="Nome">
          <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Cobrança" autoFocus />
        </Field>
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="Tipo">
            <select className="field" value={kind} onChange={(event) => setKind(event.target.value as NewLeaf['kind'])}>
              <option value="item">Item</option>
              <option value="group">Grupo</option>
            </select>
          </Field>
          <Field label="Ícone">
            <input className="field" value={icon} onChange={(event) => setIcon(event.target.value)} placeholder="emoji" maxLength={4} />
          </Field>
        </div>
        <div>
          <span className="label">Portas ligadas</span>
          <div className="flex flex-wrap gap-4">
            {PORTS.map((port) => (
              <label key={port.id} className="check">
                <input
                  type="checkbox"
                  checked={ports.includes(port.id)}
                  onChange={(event) =>
                    setPorts((current) => (event.target.checked ? [...current, port.id] : current.filter((id) => id !== port.id)))
                  }
                />
                {port.label}
              </label>
            ))}
          </div>
          <span className="hint">Sem nenhuma porta o nó entra solto; ligue depois arrastando a partir do hub.</span>
        </div>
        <div className="actions !mt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!title.trim()}>
            Adicionar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
