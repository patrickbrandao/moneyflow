---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
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
- [x] Toda rota de escrita tem ao menos um teste de integração ou de tool que a chama.
- [x] O CI mostra a cobertura do server e do shared em cada PR.
- [x] Os casos dos itens 1–3 existem e passam.

## Testes recomendados
Os dos itens 1–4 acima, nos arquivos citados.

## Limitações e suposições
Nada foi executado; a lista vem de varredura estática. Não medi a cobertura (exigiria rodar a integração). Rotas testadas só indiretamente (por um fluxo maior) foram tratadas como testadas.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Refiz a varredura no commit `5fd0efd` (integração da revisão): 339 rotas em `apps/server/src/routes`, 218 de escrita. Procurando cada caminho (parâmetros como curinga) com o método na mesma linha ou nas 3 anteriores em `apps/server/test/*.test.ts`, sobravam 38 rotas de escrita sem chamada; tirando as cobertas por uma tool testada (`update_category`/`archive_category`, `update_classification_rule`, `set_caixa_member`, `archive_ai_provider`, `delete_ai_price`, `archive_mcp_server`) e os falsos negativos dos uploads (`upload(...)`/`inject` com o método noutra linha: `/api/statements/inspect`, `/api/statement-imports`, `/api/attachments`, documentos de contrato, NF-e, `/mcp` pelo cliente MCP), confirmei as da tabela e mais: `PATCH /api/card-purchases/:id`, `PATCH /api/card-invoices/:id`, `PATCH/POST restore /api/contract-documents/:id`, `POST /api/reconcile-recipes/:id/restore`, `PUT /api/statement-imports/:id/reconcile-ai/auto` (só e2e), `POST /api/series` (nem a tool `create_series` tinha teste), `POST /api/categories/:id/restore`, `PATCH /api/caixas/:id/members/:memberId` e `DELETE /mcp`. Cobertura: confirmado, nenhum pacote tinha `@vitest/coverage-v8` nem bloco `coverage`.

## Resolução (executor)

Testes novos (arquivos próprios, para não colidir com as frentes que mexem em `titles.test.ts`, `statements.test.ts` e `agent-tools.test.ts`), todos registrados no `apps/server/test/related.json`:

- `apps/server/test/entities.test.ts` (item 1): contatos (e-mail em minúsculas, um principal por tipo), endereços (CEP normalizado, CEP inválido 400), dados bancários (dígito em maiúscula, banco ou ISPB), chaves PIX (a primeira nasce principal, trocar a principal pelo PUT, CNPJ alfanumérico em minúsculas e com pontuação normalizado na edição, chave inválida 400), vínculos (os dois lados, apagar por qualquer lado, entidade inexistente 404); o filho de outra entidade dá 404 na edição sem mexer em nada — inclusive o PUT da chave PIX com `isPrimary`, cujo "zera a principal da entidade" é desfeito pela transação (o risco apontado em `entities.ts:416` não se confirma como bug) — e é no-op na exclusão; o leitor recebe 403 em todas as escritas e no restore; arquivar a entidade em uso e restaurar (editor de cadastro), excluir a sem uso; `GET /api/lookup/cep/123` recusa antes de sair para o ViaCEP.
- `apps/server/test/title-pairs.test.ts` (item 2): cancelar e reabrir o par espelhado (pelo original e pelo espelho), reabrir aberto/parcial/pago não muda nada, o autor editor só da caixa do original cancela e reabre o par com o espelho pendente, o leitor recebe 403 em cancelar/reabrir/restaurar; excluir sem baixa apaga o par, com baixa estornada arquiva o par e restaurar pelo espelho desarquiva os dois; a ocorrência de série "só esta" arquivada com o espelho, o worker não a recria e restaurar a traz de volta; a prévia `GET /api/series/:id/end` não grava.
- `apps/server/test/charge-link.test.ts` (item 3): `POST /api/card-purchases/:id/charge-link` liga a compra avulsa à ocorrência (guia Pagamentos `charged`, a ocorrência sai das esperadas), solta com `charge: null` (`expected`), com a fatura fechada sem a compra fica `not_charged` (`summary.notCharged` 1) e ligar de novo volta a `charged`; recusa a série de outro cartão (404: `chargeTarget` trata a série de outro cartão como não encontrada, não 422 como a proposta sugeria — mantive), a ocorrência fora da série (422), a já cobrada (409) e o estorno (422 `card_purchases_recurrence_check`); o leitor do cartão recebe 403. Também `POST /api/series` (cobrança esperada solta no outro cartão), `GET /api/card-purchases/:id`, `PATCH /api/card-purchases/:id` (descrição, notas, pagadora só com a fatura aberta: 422 depois de fechada) e `PATCH /api/card-invoices/:id`.
- `apps/server/test/admin-routes.test.ts` (item 4, um caso por área em vez do `it.each` em `permissions.test.ts`): restaurar caixa (só admin) e conta (quem escreve; a conta com histórico e saldo zero arquiva), `PATCH` do membro (só admin; o de outra caixa 404; o papel vale na hora), categorias ocultas `GET/PUT` (o grupo oculto oculta as filhas, só naquela caixa), o plano de categorias (`PATCH`, `DELETE` em uso arquivando grupo e filhas, `restore`, sem uso exclui; não admin 403), mapeamentos de CSV (`PATCH` trocando o padrão, `DELETE`), `PATCH` da regra (o banco recusa ficar sem alvo ou com categoria sem sentido), `PUT .../reconcile-ai/auto`, cancelar a mensagem da fila (422 já cancelada; outro usuário 404) e restaurar o destino arquivado (desativado, sem o token na resposta), documentos de contrato (`PATCH` e `restore`), receita de conciliação (`restore`), `GET /api/users/:id` (só admin, nunca a senha), tarefas agendadas na visão do admin (`GET`, `PATCH`, `runs`, `DELETE`; não admin 403), excluir provedor (sem uso apaga, em uso arquiva), preço e servidor MCP (os cabeçalhos secretos fora da listagem) e `GET/DELETE /mcp` (401 sem chave, 405 com ela). A Bot API fica num endereço fechado nesse arquivo; os agentes e provedores criados são desativados no `afterAll`, e nenhum caso drena a fila de execuções (não precisou do `stopLeftoverRuns`).

Cobertura (item 5): `@vitest/coverage-v8` 5.0.3 (a versão do vitest) como devDependency do `@moneyflow/server` e do `@moneyflow/shared`, bloco `coverage` (`provider: 'v8'`, `include: ['src/**/*.ts']`, `reporter: ['text-summary', 'json-summary']`) nos dois `vitest.config.ts` e o script `test:coverage` em cada pacote; o CI roda os unitários e a integração com `test:coverage` e o passo "Cobertura (server e shared)" acrescenta a tabela de `scripts/coverage-summary.mjs` (lê os `coverage/coverage-summary.json`; avisa quando falta um) ao resumo do job. Sem piso por enquanto. Teste: `scripts/coverage-summary.test.mjs`. `pnpm audit --audit-level high` depois da instalação: 9 baixos e 18 moderados, nenhum alto ou crítico (no `--prod`, 9 e 15). Medido aqui: shared 76,0% das linhas.

Rotas sem teste que sobram: nenhuma de escrita. Das de leitura, `GET /api/lookup/cep/:value` só tem o caminho da validação (a consulta ao ViaCEP real não roda nos testes) e `GET /api/search` segue coberta só pela tool `search_records`.

Decisão: o restaurar do grupo de categorias desarquiva só o grupo (as filhas arquivadas junto continuam arquivadas e se restauram uma a uma); o teste não fixa esse comportamento e a spec 008 não diz nada — deixei como achado no relatório.

Docs: spec 001 (Qualidade: a cobertura e o resumo no CI) e uma linha no `AGENTS.md` (Comandos).

Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_final pnpm verify:quick --base 5fd0efd` (Biome dos alterados, typecheck de todos os pacotes, testes do shared e dos scripts, e os 4 arquivos de integração novos no Postgres local: 30 casos). Não rodei `verify:full` nem o e2e.
