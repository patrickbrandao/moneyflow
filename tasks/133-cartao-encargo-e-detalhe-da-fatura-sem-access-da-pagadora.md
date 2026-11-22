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

# Cartão: encargo aceita pagadora sem Access, e o detalhe da fatura abre com uma pagadora que não é dela

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** Access com id no corpo/query de outra caixa
- **Arquivos afetados:** `apps/server/src/services/cards.ts:331-350`, `apps/server/src/services/cards.ts:241-245`, `apps/server/src/services/cards.ts:109-149`, `apps/server/src/agents/tool-handlers-operation.ts:854-873`
- **Depende de / relacionado a:** 058 (prévias sem Access, outro ponto)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quem edita um cartão consegue lançar um encargo (juros, IOF, tarifa) "pago" por qualquer caixa do sistema, mesmo uma que não enxerga. No fechamento, essa caixa recebe uma conta a pagar aguardando aceite. Na outra ponta, quem lê uma caixa qualquer consegue abrir o resumo de uma fatura de um cartão que não lê, informando essa caixa como "pagadora".

### Evidência e análise técnica
1. **Encargo**: `createCharge` usa `input.payerCaixaId ?? card.defaultPayerCaixaId` sem conferir nada (`cards.ts:338`). A compra comum confere a leitura da pagadora (`createPurchase`, `cards.ts:244-245`: `ctx.access.assertRead(payerCaixaId)`), e `updatePurchase` também (`cards.ts:358`). `insertPurchase` só exige que a caixa seja `general` (`card-core.ts:125-127`). A tool `create_card_charge` chama o mesmo serviço e a prévia confere só a escrita no cartão (`tool-handlers-operation.ts:856`). No fechamento manual, `closeInvoiceTx` cria o par de títulos nessa caixa com `mirror_status` `pending`, porque quem fecha não escreve nela (`cards.ts:418`). No fechamento automático (`CARD_AUTO_CLOSE=true`), o título nasce já `accepted` (`cards.ts:562`: `mirrorStatusFor: () => 'accepted'`).
2. **Detalhe da fatura**: sem leitura do cartão, `getInvoice` libera o acesso se o usuário lê a caixa informada em `?payerCaixaId=` (`cards.ts:112-114`), sem conferir que ela é pagadora DESTA fatura. As linhas e os pagadores saem filtrados (ficam vazios), mas o resumo da fatura inteira (`total_cents`, `billed`, `settled`, `open`, status, datas), o nome do cartão e o do emissor voltam (`cards.ts:118-121`, `162-166`). As linhas 115-116 repetem a checagem anterior e não fazem nada.

### Verificação (tentativa de refutação)
- O banco só confere o tipo da pagadora (`card_invoice_items_payer_kind_check`), não a permissão, que é da aplicação ("Toda permissão passa por Access").
- Os dois casos exigem o UUID da caixa ou da fatura. Por isso a severidade é baixa. Mesmo assim, é uma escrita numa caixa sem nenhum direito sobre ela (1) e uma leitura de dados de um cartão sem direito (2).
- O teste `cards.test.ts:183-187` cobre a pagadora real e uma caixa ilegível, mas não uma caixa legível que não é pagadora.

### Impacto
(1) Um editor do cartão, ou o agente dele, pode empurrar uma conta para a caixa de terceiros: pendente de aceite no fechamento manual, já aceita no automático. (2) Vazam os totais de uma fatura de outro cartão.

## Como reproduzir
1. Usuário editor só do cartão C: `POST /api/cards/C/charges` com `payerCaixaId` de uma caixa X que ele não lê. Responde 200, e no fechamento X tem um título a pagar pendente.
2. Usuário que lê só a caixa X, que não paga a fatura F do cartão C: `GET /api/card-invoices/F?payerCaixaId=X` devolve `totalCents`, `cardName` e `issuerName` de F.

## Solução proposta
- `createCharge`: `ctx.access.assertRead(payerCaixaId)` como na compra (na transação, depois de resolver a padrão).
- `getInvoice`: sem leitura do cartão, exigir que `payerCaixaId` apareça em `card_invoice_payer_totals` da fatura (senão 404), e remover as linhas 115-116.

## Critérios de aceite
- [ ] Encargo com pagadora ilegível devolve 404/403.
- [ ] `GET /api/card-invoices/:id?payerCaixaId=` com uma caixa legível que não é pagadora devolve 404.

## Testes recomendados
`apps/server/test/cards.test.ts`, no caso "a pagadora só vê as compras dela": a caixa legível sem compras na fatura recebe 404, e um encargo para uma pagadora ilegível é recusado.

## Limitações e suposições
Nada foi executado. Não foi conferido se a tela já limita o seletor de pagadora às caixas legíveis. O problema está na API.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `createCharge` usava `input.payerCaixaId ?? card.defaultPayerCaixaId` sem conferir a leitura (a compra conferia). `getInvoice`, sem leitura do cartão, liberava o resumo da fatura para qualquer caixa legível em `?payerCaixaId=`. As linhas 115 e 116 repetiam a checagem.

## Resolução (executor)

- `apps/server/src/services/cards.ts`: `createCharge` confere `assertRead` na pagadora resolvida (a pedida ou a padrão), como a compra. Sem leitura do cartão, `getInvoice` exige que a caixa esteja em `card_invoice_payer_totals` da fatura (senão 404), e as linhas redundantes saíram.
- `apps/server/src/agents/tool-handlers-operation.ts`: a prévia de `create_card_charge` confere a leitura da pagadora pedida.
- `docs/007-cartao-de-credito.md`.
- Teste: `apps/server/test/cards.test.ts`, no caso "a pagadora só vê as compras dela". A caixa legível sem compras na fatura de 12/2026 recebe 404. O editor só do cartão recebe 404 no encargo para a pagadora B e para a padrão (A), que ele não lê. O teste falha sem a correção.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
