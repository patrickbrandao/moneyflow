import { type ContractCandidateInfo, formatAccounting, formatMonth, t } from '@moneyflow/shared';

const S = t.statements.contractSplit;

/**
 * A parcela de contrato sugerida (spec 033): contrato n/N e o mês, como o
 * valor bateu, os dias em relação ao vencimento e a repartição da baixa.
 */
export function ContractSplit({ info }: { info: ContractCandidateInfo }) {
  const { split } = info;
  const parts = [
    `${S.principal} ${formatAccounting(split.amountCents)}`,
    ...(split.fineCents ? [`${S.fine} ${formatAccounting(split.fineCents)}`] : []),
    ...(split.interestCents ? [`${S.interest} ${formatAccounting(split.interestCents)}`] : []),
    ...(split.discountCents ? [`${S.discount} ${formatAccounting(split.discountCents)}`] : []),
  ];
  return (
    <span className="row-sub" data-testid="contract-split">
      {S.installment(info.contractName, info.installment, info.installmentsCount, formatMonth(info.dueDate))} · {S.kinds[split.kind]} ·{' '}
      {S.days(split.days)}
      <br />
      {parts.join(' · ')}
    </span>
  );
}
