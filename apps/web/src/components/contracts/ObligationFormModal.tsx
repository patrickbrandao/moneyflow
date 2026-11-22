import { type ContractDetail, t } from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { FormError, ModalActions } from '../forms';
import { Button, Modal } from '../ui';
import { newObligationDraft, ObligationFields, obligationInputOf, obligationProblem } from './ObligationFields';
import { useObligationOptions } from './obligation-options';

const O = t.contracts.obligation;

/** "Adicionar obrigação" a um contrato vigente (spec 034). */
export function ObligationFormModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const options = useObligationOptions(contract.entityId);
  const [draft, setDraft] = useState(() => newObligationDraft({ description: contract.name }));
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = obligationProblem(draft, contract.direction);
    if (problem) return setError(problem);
    setError(null);
    const saved = await run(() => api.post<ContractDetail>(`/api/contracts/${contract.id}/obligations`, obligationInputOf(draft)), O.added);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={O.newTitle} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} data-testid="obligation-form">
        <div className="modal-body">
          <ObligationFields
            value={draft}
            onChange={setDraft}
            direction={contract.direction}
            caixaId={contract.caixaId}
            options={options}
            defaultCategoryName={contract.categoryName}
          />
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy} data-testid="obligation-submit">
            {busy ? t.common.saving : t.contracts.actions.addObligation}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
