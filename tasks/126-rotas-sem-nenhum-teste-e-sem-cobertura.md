---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Rotas de escrita sem nenhum teste (integração, tool ou e2e) e cobertura nunca medida

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** teste
- **Subcategoria:** lacunas de teste por rota
- **Arquivos afetados:** `apps/server/src/routes/entities.ts:28`, `apps/server/src/routes/entities.ts:41-62`, `apps/server/src/routes/titles.ts:35`, `apps/server/src/routes/titles.ts:37`, `apps/server/src/routes/cards.ts:35`, `apps/server/src/routes/caixas.ts:38-54`, `apps/server/src/routes/statements.ts:128-129`, `apps/server/src/routes/vision.ts:42`, `apps/server/src/routes/vision.ts:53`, `apps/server/src/routes/agents.ts:232-235`, `apps/server/src/routes/agents.ts:262`, `apps/server/vitest.config.ts:9-17`, `packages/shared/vitest.config.ts:1-3`
- **Depende de / relacionado a:** tarefa 127
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Algumas ações que o usuário faz na tela — editar ou apagar o contato, o endereço, a conta bancária ou a chave PIX de uma entidade, reabrir um título cancelado, ligar uma compra do cartão à cobrança de um contrato — nunca são exercitadas por teste nenhum. Um erro nelas só aparece quando alguém usa. E ninguém sabe quanto do código os testes cobrem, porque isso nunca é medido.

### Evidência e análise técnica
Varri as 336 rotas `app.get/post/put/patch/delete` de `apps/server/src/routes/*.ts` e procurei cada caminho (com os parâmetros como curinga) nos testes de integração (`apps/server/test/*.test.ts`) e nos e2e (`e2e/tests/*`). Para os 39 sem chamada, procurei também a função do serviço nos testes e nas tools dos agentes (que têm teste próprio em `agent-tools*.test.ts`). Sobram sem **nenhum** teste, em nenhuma camada:

| Rota | Serviço | Risco |
|---|---|---|
| `PUT/DELETE /api/entities/:id/contacts/:childId` | `entities.updateContact`/`deleteContact` | dados do cadastro |
| `POST/PUT/DELETE /api/entities/:id/addresses[/:childId]` | `addAddress`/`updateAddress`/`deleteAddress` | idem |
| `POST/PUT/DELETE /api/entities/:id/bank-accounts[/:childId]` | `addBankAccount`/`updateBankAccount`/`deleteBankAccount` | dados para pagamento |
| `PUT/DELETE /api/entities/:id/pix-keys/:childId` | `updatePixKey`/`deletePixKey` | `isPrimary` é zerado para a entidade inteira antes do UPDATE (`entities.ts:416`) |
| `POST/DELETE /api/entities/:id/links[/:childId]`, `POST /api/entities/:id/restore` | `addLink`/`deleteLink`/`restoreEntity` | |
| `POST /api/titles/:id/reopen` | `titles.reopenTitle` | reabre o par (título e espelho) |
| `POST /api/titles/:id/restore` | `titles.restoreTitle` | desarquiva o par, inclusive ocorrência de série |
| `POST /api/card-purchases/:id/charge-link` | `cards.linkPurchaseCharge` | liga/solta a compra da ocorrência (spec 034: "não cobrada") |
| `POST /api/caixas/:id/restore`, `POST /api/accounts/:id/restore`, `GET/PUT /api/caixas/:id/hidden-categories` | `caixas.*` | |
| `PATCH/DELETE /api/csv-mappings/:id` | `statements.*` | |
| `POST /api/message-destinations/:id/restore`, `POST /api/message-outbox/:id/cancel` | `messages.*` | |
| `GET/PATCH/DELETE /api/admin/ai/agent-tasks/:id`, `GET .../:id/runs` | `agent-tasks.*` (variantes do admin) | |
| `DELETE /api/admin/ai/prices/:id`, `GET /api/lookup/cep/:value` | | |

Ficaram cobertas por outra camada e saíram da lista: `GET /api/search` (pela tool `search_records`), as rotas de categoria (`update_category`/`archive_category` em `agent-tools.test.ts:1030-1032`), `POST /api/cards/:id/charges` (`create_card_charge`), `PUT .../reconcile-ai/auto` (só e2e, `agentes.spec.ts:892`).

Cobertura: nenhum pacote tem `@vitest/coverage-v8` instalado (as entradas no `pnpm-lock.yaml` são só o peer opcional do vitest), os `vitest.config.ts` não têm bloco `coverage`, e o CI não mede nada (`ci.yml:26-29`). Não há como ver a regressão de cobertura num PR.

### Verificação (tentativa de refutação)
- Confirmei por `grep` que nenhuma das funções da tabela aparece em `apps/server/test`, `e2e/tests` ou em `apps/server/src/agents/*` (ou seja, não há tool que as use e seja testada).
- `cnpj-alfanumerico.test.ts` diz que a chave PIX alfanumérica tem os casos "nos testes de cada área"; a validação está nos unitários do shared (`pix-address.test.ts`), mas o caminho de **edição** da chave pela API (`PUT .../pix-keys/:childId`) não é chamado em lugar nenhum.
- A varredura é aproximada (regex sobre o caminho); rotas chamadas com URL montada de forma incomum podem ter escapado como "testadas", não o contrário.

### Impacto
Regressão silenciosa em operações de cadastro e de estado do título; no caso do `charge-link`, uma regressão muda a guia Pagamentos do contrato (cobrança marcada "não cobrada" indevidamente). Sem cobertura medida, a lacuna cresce a cada fase sem ninguém ver.

## Como reproduzir
Um script de varredura de rotas (o usado nesta revisão ficou no rascunho do revisor, fora do repositório): para cada `app.<método>('<caminho>'` de `apps/server/src/routes/*.ts`, troque `:param` por um curinga e procure o caminho em `apps/server/test/*.test.ts` e `e2e/tests/*`. Resultado: 336 rotas, 39 sem chamada nos testes de integração, e depois o `grep` da função de cada uma em `apps/server/test`, `e2e/tests` e `apps/server/src/agents`.

## Solução proposta
1. `apps/server/test/entities.test.ts` (novo): ciclo completo dos filhos da entidade — criar, editar, apagar contato, endereço, conta bancária, chave PIX (inclusive trocar a principal e uma chave CNPJ alfanumérica em minúsculas no PUT), vínculo; editar filho de **outra** entidade dá 404; leitor (viewer) recebe 403; arquivar e restaurar a entidade.
2. `apps/server/test/titles.test.ts`: cancelar e reabrir um título espelhado (os dois lados voltam a `open`; reabrir um pago não muda nada); excluir com baixa (arquiva) e restaurar o par.
3. `apps/server/test/contracts.test.ts`: `POST /api/card-purchases/:id/charge-link` ligando uma compra avulsa à ocorrência esperada e soltando (`charge: null`), conferindo a guia Pagamentos e o "não cobrada"; ligar a série de outro cartão dá 422.
4. Rotas de restore e de admin: um `it.each` por rota em `permissions.test.ts` (não admin → 403/404, admin → 200).
5. Medir: `@vitest/coverage-v8` no server e no shared, `coverage: { provider: 'v8', reporter: ['text-summary', 'json-summary'] }`, publicar o resumo no CI (sem threshold no começo; depois um piso por pacote para não regredir).

## Critérios de aceite
- [ ] Toda rota de escrita tem ao menos um teste de integração ou de tool que a chama.
- [ ] O CI mostra a cobertura do server e do shared em cada PR.
- [ ] Os casos dos itens 1–3 existem e passam.

## Testes recomendados
Os dos itens 1–4 acima, nos arquivos citados.

## Limitações e suposições
Nada foi executado; a lista vem de varredura estática. Não medi a cobertura (exigiria rodar a integração). Rotas testadas só indiretamente (por um fluxo maior) foram tratadas como testadas.

## Análise (triagem)

## Resolução (executor)
