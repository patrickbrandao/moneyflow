---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 14aa8fe
---

# Cancelar, arquivar ou rescindir deixa a linha do extrato sugerida para o título cancelado

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** sugestão órfã na conciliação (título cancelado)
- **Arquivos afetados:** `apps/server/src/services/titles.ts:429-438`, `apps/server/src/services/titles.ts:471`, `apps/server/src/services/titles.ts:486-499`, `apps/server/src/services/titles.ts:477,588-591,627` (contraste), `apps/server/src/services/contracts.ts:870`, `apps/server/src/services/series.ts:498-529`, `apps/server/src/services/cards.ts:474-477`, `apps/server/src/services/card-core.ts:313` (contraste), `apps/server/src/services/reconciliation-guards.ts:27-36`, `apps/server/src/services/reconciliation.ts:170-183`, `apps/server/src/services/statements.ts:704-708`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A conciliação sugere que uma linha do extrato é o pagamento de um título, de uma parcela do contrato ou da fatura do cartão. Se o título é cancelado antes de confirmar (cancelamento direto, "Excluir só esta" numa série, que arquiva, rescisão do contrato ou "nada pago, rola tudo" na fatura), a linha continua como "sugerida" para ele. Confirmar falha com "Título cancelado não recebe baixa", e a linha só sai disso desfazendo a sugestão à mão.

### Evidência e análise técnica
O projeto limpa as sugestões sempre que cancela ou apaga um título por alguns caminhos: `clearStatementSuggestions` devolve para "nova" as linhas `suggested` que apontam para os títulos (`reconciliation-guards.ts:27-36`) e é chamado antes de excluir o par (`titles.ts:477`), antes de cancelar no "Encerrar série" (`applySeriesEnd`, `titles.ts:588-591` e `:589`), no "Excluir este e os próximos" (`titles.ts:627`) e em `reopenInvoiceTx` (`card-core.ts:313-320`). Os caminhos abaixo, do mesmo padrão, não chamam:

**Cancelamento e arquivamento de título (`titles.ts`).**
- `cancelTitle` (`titles.ts:429-438`), o "Excluir" de ocorrência de série, que arquiva (`titles.ts:471`), e `archiveTitle` (`titles.ts:486-499`) não chamam.

**Rescisão do contrato.**
- `terminateContract` cancela as ocorrências com `patchOccurrence(..., { status: 'canceled' })` (`contracts.ts:870`), que só faz o UPDATE no título e no espelho (`series.ts:498-529`, `:511-528`), sem limpar.

**Fatura do cartão ("nada pago").**
- `payInvoice` com `amountCents: 0` cancela o par da fatura (`cards.ts:474-477`), também sem limpar.

**Consequências.**
- `confirmLines` aplica a sugestão como está (`reconciliation.ts:170-183`, um savepoint por linha); com o título cancelado, o banco recusa (`settlements_title_canceled_check`, em `settlements_validate`; mensagem "Título cancelado não recebe baixa.") e a linha entra em `failed`. Ela fica `suggested` até alguém desfazer à mão.
- O `autoMatch` dos lotes seguintes trata o título ainda como "usado" pela sugestão antiga (`statements.ts:704-708`).

### Verificação (tentativa de refutação)
- Banco: nenhum trigger limpa a sugestão quando o status do título muda; a FK de `statement_lines.title_id` só pesa na exclusão física. A limpeza é da aplicação, por `clearStatementSuggestions`.
- Os candidatos novos já ignoram título arquivado ou cancelado (`statements.ts:574,622`); o problema é só a sugestão já gravada.
- Testes: `statements.test.ts` não cancela título sugerido; os testes de rescisão (`contracts.test.ts:728-774`) e de pagamento (`cards.test.ts:99-121`) não têm linha sugerida.
- Não foi conferido se a tela de conciliação já esconde as sugestões de título cancelado ao montar o lote.

### Impacto
Linha "sugerida" que não confirma, mensagem de erro pouco clara no lote, conciliação com sugestões mortas (a linha parece casada com uma parcela que não existe mais) e o título preso no `used` do `autoMatch`. Afeta quem cancela contas, rescinde contratos ou cancela faturas enquanto há extrato importado e não conciliado.

## Como reproduzir
1. Título a pagar de 100,00; importar OFX com uma saída de 100,00 na data, que fica `suggested` para ele. `POST /api/titles/<id>/cancel`. Confirmar a linha no lote: falha com "Título cancelado não recebe baixa."
2. Repetir com o "Excluir só esta" de uma ocorrência de série (arquiva).
3. Rescisão: importar um extrato cuja linha seja sugerida para a ocorrência de março de um aluguel; rescindir o contrato em fevereiro (`POST /api/contracts/:id/terminate`). A linha continua `suggested` para o título cancelado, e `POST /api/statement-lines/confirm` com ela devolve a linha em `failed`.
4. Fatura: pagar com `amountCents: 0` e conferir a linha sugerida para a fatura.

## Solução proposta
- Chamar `clearStatementSuggestions(tx, { titleIds: par })` em `cancelTitle`, `archiveTitle` e no ramo "só esta" de `deleteTitle`, antes do UPDATE, como já fazem os outros caminhos.
- Em `patchOccurrence`, quando `patch.status === 'canceled'`, chamar `clearStatementSuggestions(tx, { titleIds: [row.id, row.mirrorTitleId].filter(Boolean) })`. Isso também cobre outros chamadores futuros.
- Em `payInvoice`, chamar `clearStatementSuggestions(tx, { titleIds: pair })` antes de cancelar o par.

## Critérios de aceite
- [ ] Cancelar ou arquivar um título com linha sugerida devolve a linha para "nova" (`status = 'new'`, `titleId = null`).
- [ ] Depois da rescisão e do "nada pago", nenhuma linha `suggested` aponta para título cancelado.

## Testes recomendados
- `test/statements.test.ts`: importar o OFX do fixture com a linha sugerida para um título, cancelar o título e conferir `status = 'new'` e `titleId = null` na linha; repetir com o "Excluir só esta" de uma ocorrência de série.
- `apps/server/test/contracts.test.ts` (rescisão) e `apps/server/test/cards.test.ts` (pagamento com `amountCents: 0`): importar um OFX que gere a sugestão, cancelar e conferir `status = 'new'` e `title_id` nulo na linha.

## Limitações e suposições
Nada foi executado. Os caminhos de cancelamento das faturas de cartão em `reopenInvoiceTx` (`card-core.ts:313-320`) já limpam e não foram revistos a fundo.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `cancelTitle`, `archiveTitle`, o "só esta" do `deleteTitle`, o `patchOccurrence` com `status: 'canceled'` (rescisão) e o "nada pago" do `payInvoice` não chamavam `clearStatementSuggestions`. Os testes novos falham sem a correção.

## Resolução (executor)

- `apps/server/src/services/titles.ts`: `clearStatementSuggestions` do par antes de cancelar (`cancelTitle`), de arquivar (`archiveTitle`) e no "Excluir só esta" de uma ocorrência de série.
- `apps/server/src/services/series.ts`: `patchOccurrence` com `status: 'canceled'` limpa as sugestões do título e do espelho (cobre a rescisão e outros chamadores).
- `apps/server/src/services/cards.ts`: `payInvoice` com nada pago limpa as sugestões do par antes de cancelá-lo.
- `docs/009-extratos-e-conciliacao.md`: a regra.
- Testes: `apps/server/test/statements.test.ts`, `describe('título cancelado deixa de ser sugerido (tarefa 129)')` (cancelar, "Excluir só esta" numa série e pagar 0 na fatura); `apps/server/test/contracts.test.ts`, `describe('rescisão e a sugestão do extrato (tarefa 129)')`.
- Verificação: `pnpm verify:quick` (nível rápido).
