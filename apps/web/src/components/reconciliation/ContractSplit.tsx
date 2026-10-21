import { formatAccounting, formatMonth, type SeriesCandidateInfo, t } from '@moneyflow/shared';

const S = t.statements.contractSplit;

/**
 * A ocorrência de série sugerida (specs 033 e 034): o contrato (ou, sem
 * contrato, a descrição da série), a ocorrência e o mês, como o valor bateu,
 * os dias em relação ao vencimento e a repartição da baixa.
 */
export function ContractSplit({ info, description }: { info: SeriesCandidateInfo; description: string }) {
  const { split } = info;
  const parts = [
    `${S.principal} ${formatAccounting(split.amountCents)}`,
    ...(split.fineCents ? [`${S.fine} ${formatAccounting(split.fineCents)}`] : []),
    ...(split.interestCents ? [`${S.interest} ${formatAccounting(split.interestCents)}`] : []),
    ...(split.discountCents ? [`${S.discount} ${formatAccounting(split.discountCents)}`] : []),
  ];
  return (
    <span className="row-sub" data-testid="contract-split" data-series={info.ruleId}>
      {S.installment(info.contractName ?? description, info.occurrence, info.occurrencesTotal, formatMonth(info.dueDate))} ·{' '}
      {S.kinds[split.kind]} · {S.days(split.days)}
      <br />
      {parts.join(' · ')}
    </span>
  );
}
