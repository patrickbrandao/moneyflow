---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Contrato mostra dados de caixas que o usuário não lê (próxima ocorrência e cobranças no cartão)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** leitura sem Access em subconsulta
- **Arquivos afetados:** `apps/server/src/services/contracts.ts:163-184`, `apps/server/src/services/contracts.ts:325`, `apps/server/src/services/contracts.ts:1097-1103`, `apps/server/src/services/series.ts:220-229`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Um contrato pode ter obrigações em contas de outras caixas e cobranças num cartão. Quem lê só a caixa do contrato não vê essas obrigações no detalhe, mas a lista de contratos mostra a "próxima ocorrência" delas (descrição, valor, vencimento), e a guia Pagamentos mostra as compras do cartão. Quem vê o contrato pelo espelho, da caixa da contraparte, vê na guia Pagamentos só as cobranças no cartão da outra parte e nenhuma das suas parcelas.

### Evidência e análise técnica
- `listSelect`/`listFrom` (`contracts.ts:168-184`): o `LATERAL nx` pega o próximo título em aberto de `x.contract_id = c.id AND x.mirror_status IS NULL` em qualquer caixa, e `without_account` conta títulos em qualquer caixa. O `toRow` devolve `nextOccurrence` com `titleId`, `description`, `amountCents` e `dueDate` (`contracts.ts:195-204`). Isso vale para `listContracts` e para o cabeçalho de `getContract` (`contractRow`).
- O detalhe filtra as obrigações pelas caixas legíveis (`seriesWhere`, `series.ts:224`; chamado em `contracts.ts:325`), o que mostra que a intenção é esconder as séries de caixas não legíveis.
- `contractPayments` filtra `WHERE ${readableFilter(...p.caixa_id)} OR p.kind = 'card_charge'` (`contracts.ts:1102`): as linhas do cartão (caixa = o cartão) passam sem conferir a leitura do cartão nem da pagadora, com `cardPurchaseId`, `cardInvoiceId`, a data e o valor da compra.
- No modo espelho, `contract_payments` só devolve o lado do contrato (`mirror_status IS NULL`, `schema.sql:5743`), que fica na caixa dona. O filtro corta todas as parcelas e sobram só as do cartão.

### Verificação (tentativa de refutação)
- O cenário é previsto pela spec: obrigação "na caixa da conta (que pode não ser a do contrato)" (`docs/020:15`, testado em `contracts.test.ts:117`).
- Os títulos da próxima ocorrência não vazam segredo, mas violam "só caixas legíveis" (regras da aplicação), e a própria API esconde a mesma série no detalhe.
- O teste de espelho (`contracts.test.ts:780-814`) não abre a guia Pagamentos.

### Impacto
Membros de uma caixa veem descrição, valor e vencimento de títulos e compras de outra caixa ou cartão a que não têm acesso. A guia Pagamentos do espelho fica vazia, fora o cartão, e engana quem consulta.

## Como reproduzir
1. Contrato na caixa A com uma obrigação na conta da caixa C e uma cobrança no cartão K.
2. Usuário só leitor de A: `GET /api/contracts` traz `nextOccurrence` da série de C. `GET /api/contracts/:id/payments` traz as linhas `card_charge` de K.

## Solução proposta
- No `nx` e em `without_account`, acrescentar `AND ${readableFilter(ctx.access, sql`x.caixa_id`)}` (passar o `ctx` para `listSelect`/`listFrom` ou montá-los numa função).
- Em `contractPayments`, exigir para `card_charge` a leitura do cartão ou da pagadora (`card_recurring_charges.payer_caixa_id`), por exemplo com um JOIN na série.
- No modo espelho, mostrar as parcelas do lado legível (o espelho) ou esconder a guia. Decidir na spec 020 ("Espelho").

## Critérios de aceite
- [ ] Leitor só da caixa do contrato não recebe próxima ocorrência nem contagens de séries de caixas que não lê.
- [ ] As linhas de cobrança no cartão só aparecem para quem lê o cartão ou a pagadora.

## Testes recomendados
`apps/server/test/contracts.test.ts`, no `describe('espelho e permissões')`: obrigação numa caixa não legível pelo usuário e uma cobrança no cartão, conferindo `nextOccurrence`, `withoutAccount` e as linhas de `/payments`.

## Limitações e suposições
Nada foi executado. Se o produto quiser que o leitor do contrato veja tudo das obrigações, o detalhe (`seriesWhere`) está errado no sentido oposto, e a spec deve dizer qual das duas regras vale.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: o `LATERAL nx`, `without_account` e `obligation_count` de `listSelect`/`listFrom` olhavam títulos e séries de qualquer caixa. Em `contractPayments`, toda linha `card_charge` passava sem conferir o cartão nem a pagadora, e no modo espelho as parcelas sumiam, porque `contract_payments` só devolve o lado do contrato.

## Resolução (executor)

- `apps/server/src/services/contracts.ts`: `listSelect(ctx)`/`listFrom(ctx)` filtram `obligation_count`, `without_account` e a próxima ocorrência pelas caixas legíveis (`readableFilter`). A próxima é a do lado legível do par: o original quando legível, senão o espelho (`ORDER BY …, mirror_status IS NOT NULL`). `contractPayments` mostra a ocorrência legível pela caixa dela ou pelo espelho. A cobrança no cartão só aparece para quem lê o cartão, a pagadora da série (`card_recurring_charges`) ou a da compra.
- Decisão (spec 020, "Espelho"): quem vê pelo espelho vê na guia Pagamentos as ocorrências do lado dele. A linha aponta para o título espelho e a caixa da contraparte, e saem os ids do lado do contrato: conta, conta prevista e, nas baixas, conta, transferência, conta de origem e linha do extrato.
- `docs/020-contratos.md`: "Espelho" e "Visões".
- Testes: `apps/server/test/contracts.test.ts`, no `describe('espelho e permissões')`. O caso do espelho confere `/payments` (6 linhas pelo espelho, sem conta) e a lista (`obligationCount` 0, próxima = o título espelho). O caso novo, "leitor só da caixa do contrato não vê a próxima ocorrência, as contagens nem as cobranças no cartão de caixas que não lê (tarefa 134)", tem o cofre da caixa B, um cartão com a pagadora B e um leitor só de A: a próxima passa a ser o aluguel de A, as obrigações contam 1 e o cartão some, até ele passar a ler B.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
