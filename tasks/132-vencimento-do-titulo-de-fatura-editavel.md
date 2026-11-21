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

# O vencimento do título de fatura de cartão muda pelo calendário e pelo PATCH, descolando da fatura

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** trava do título de fatura só na tela
- **Arquivos afetados:** `apps/server/src/services/titles.ts:340-372`, `apps/server/src/services/titles.ts:463,490` (contraste), `apps/server/src/services/calendar.ts:39-45`, `apps/web/src/components/calendar/CalendarGrid.tsx:8`, `apps/web/src/pages/CalendarPage.tsx:117-128`, `apps/web/src/components/titles/TitleFormModal.tsx:79-80,123`, `database/schema.sql:20804` e `4670-4716`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A fatura do cartão tem o próprio vencimento, e a tela de edição do título da fatura trava valor e vencimento ("mudam pela fatura"). Mas no calendário dá para arrastar o título de uma fatura fechada para outro dia, e a API aceita. O título passa a vencer num dia e a fatura em outro.

### Evidência e análise técnica
- `updateTitle` não olha `cardInvoiceId` (`titles.ts:340-372`), ao contrário de `deleteTitle` e `archiveTitle`, que recusam com `cardInvoiceTitleLocked` (`titles.ts:463,490`). Com espelho, `syncMirror` leva o vencimento novo aos dois lados.
- No calendário, `canReschedule` vale para todo item `title` com escrita (`calendar.ts:39-45`); `is_invoice_title` vem na resposta mas não entra na conta. `CalendarGrid.isMovable` (`CalendarGrid.tsx:8`) libera o arrastar e `CalendarPage.tsx:128` faz `PATCH /api/titles/:id { dueDate }`.
- O formulário trava (`TitleFormModal.tsx:79-80,123`), o que mostra a intenção.
- No banco, `titles_card_invoice_integrity_check` só dispara em `card_invoice_id, caixa_id, counterparty_caixa_id, amount_cents, status` (`schema.sql:20804`), e `card_invoice_assert` confere totais, não datas (`schema.sql:4670-4716`). Valor e cancelamento ficam protegidos; o vencimento não.

### Verificação (tentativa de refutação)
- O lado da pagadora é espelho: lá o arrastar exige escrita também no cartão. No lado do cartão (original), basta escrever no cartão. O admin arrasta em qualquer lado.
- Testes: nenhum caso muda o vencimento de título de fatura.

### Impacto
Calendário, vencidos e saldo projetado usam `titles.due_date`; as telas do cartão usam `card_invoices.due_date`. A mesma fatura aparece vencida num lugar e em dia no outro.

## Como reproduzir
1. Cartão com uma fatura fechada (título a receber no cartão, a pagar na pagadora).
2. Como editor do cartão, no calendário, arrastar o item da fatura para outro dia (ou `PATCH /api/titles/<título da fatura> { dueDate: "<outro dia>" }`).
3. `GET /api/titles/<id>` mostra o vencimento novo; a fatura do cartão continua com o antigo.

## Solução proposta
1. Em `updateTitle`, com `title.cardInvoiceId`, recusar mudança de `dueDate`, `amountCents` e `competenceDate` com `cardInvoiceTitleLocked` (422).
2. Em `calendarItems`, `canReschedule = false` quando `isInvoiceTitle`.

## Critérios de aceite
- [ ] `PATCH` do vencimento de título de fatura responde 422 com a mensagem pt-BR.
- [ ] O calendário não deixa arrastar título de fatura.

## Testes recomendados
`test/operation.test.ts`, no `describe('calendário (spec 012)')`: fatura fechada, `canReschedule` falso no item e `PATCH` do vencimento recusado. Pode reaproveitar o cenário de fatura de `test/cards.test.ts`.

## Limitações e suposições
Nada foi executado. Supõe que mudar o vencimento da fatura é sempre pela tela do cartão (`invoiceDates`, spec 007).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `updateTitle` não olhava `cardInvoiceId` e o `canReschedule` do calendário valia para o título de fatura.

## Resolução (executor)

- `apps/server/src/services/titles.ts`: `updateTitle` recusa mudar valor, vencimento ou competência de título de fatura (422 `card_invoice_title_locked`, `t.errors.cardInvoiceTitleLocked`); o corpo com os mesmos valores (o do formulário) continua passando.
- `apps/server/src/services/calendar.ts`: `canReschedule` falso para o título de fatura (o `isMovable` do calendário já depende dele).
- `apps/web/src/components/titles/TitleFormModal.tsx`: a competência também fica só leitura no título de fatura.
- `docs/007-cartao-de-credito.md` e `docs/012-calendario.md`: a trava.
- Teste: `apps/server/test/operation.test.ts`, no `describe('calendário (spec 012)')`, "o título de fatura não se arrasta nem muda de vencimento pelo PATCH (tarefa 132)" (os dois lados sem `canReschedule`, 422 no vencimento, no valor e na competência, descrição editável).
- Verificação: `pnpm verify:quick` (nível rápido).
