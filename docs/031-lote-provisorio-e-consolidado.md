# 031 — Lote provisório de extrato e a troca pelo consolidado (F17)

Um **lote provisório** é um extrato parcial de conta corrente ou poupança ([009](009-extratos-e-conciliacao.md)), como os últimos 30 dias que o banco libera durante o mês, importado para conciliar o mês corrente sem esperar o extrato fechado. Quando o banco libera o **consolidado** do mês, ele **substitui** o provisório: as conciliações passam para as linhas do consolidado sem duplicar nem perder o trabalho, e o que não casa vira pendência explícita. Decisões de 2026-10-19.

O caso de origem: o Santander só entrega o extrato em PDF, convertido para OFX. O parcial e o consolidado do mesmo mês trazem as mesmas transações com descrições, ordem e às vezes datas diferentes (na auditoria da conta corrente, 8 linhas vieram 1–2 dias antes no OFX que no PDF). A deduplicação da [009](009-extratos-e-conciliacao.md) (FITID ou hash de data, valor, descrição e ordem) não reconhece essas linhas como as mesmas, e o consolidado duplicaria o mês.

Só lotes de **conta** (`checking`/`savings`). A fatura do cartão tem fechamento próprio ([007](007-cartao-de-credito.md)) e fica fora.

## Marcar como provisório

- **Ao importar**: a tela de importação tem "Extrato parcial (provisório)", desligado por padrão, com a explicação "Use para um extrato que ainda não fechou o mês; quando o banco liberar o consolidado, troque por ele". A API e a tool `import_statement` recebem `provisional`.
- **Depois**: no detalhe do lote, "Marcar como provisório" e "Desmarcar provisório" (escrita na caixa). Lote substituído não muda mais; lote não provisório que já substituiu outro não vira provisório. A troca fica na auditoria.
- **Deduplicação**: as linhas de lote provisório **não contam** na deduplicação da conta. O provisório deduplica só contra as linhas dos lotes não provisórios (o que o consolidado de um mês anterior já trouxe não entra de novo); o consolidado importa o mês inteiro, inclusive as transações que o provisório já trouxe. Desmarcar um provisório cujas linhas repetem as de outro lote é recusado (409, `statement_provisional_duplicated`, com quantas linhas).
- **Sem sobreposição**: dois provisórios ativos (não substituídos) da mesma conta não têm períodos sobrepostos. Importar um provisório que cobre o período de outro ativo **substitui o anterior** na mesma transação (um parcial mais novo do mesmo mês troca o mais velho, pela regra abaixo); marcar como provisório um lote que se sobrepõe a outro provisório ativo é recusado (422, `statement_provisional_overlap`).
- **Mês fechado**: um lote com linha num mês fechado da caixa ([008](008-categorias-auditoria-e-exclusao.md)) não vira provisório, nem na importação nem depois (422, `statement_provisional_closed_month`).
- **Na tela**: o lote provisório leva o selo **Provisório** na lista de lotes e no detalhe; o lote substituído leva **Substituído por <arquivo>** (link para o consolidado), em tom apagado.

## Saldo e divergência

- O provisório **entra na comparação de saldos** ([009](009-extratos-e-conciliacao.md): acumulada e do intervalo) enquanto está ativo, como qualquer lote: o saldo do arquivo parcial é o saldo do banco naquela data.
- **Substituído, sai**: o lote substituído não mostra divergência (nem acumulada nem do intervalo) e não serve de "lote anterior" no cálculo do intervalo de outro lote. Assim, depois da troca, o intervalo do consolidado é medido contra o consolidado anterior. O aviso de divergência do Telegram e do sino (`reconciliation_divergence`, [013](013-mensagens-telegram.md)) ignora os lotes substituídos.

## Substituir pelo consolidado

A operação parte de um **lote consolidado** (não provisório, da mesma conta) e de um ou mais **provisórios ativos** da conta. Roda **numa transação só**, com a trava dos lotes envolvidos, e é recusada (409, `run_active`) enquanto qualquer um deles tem uma conciliação com IA ou receita em andamento ([029](029-fluxos-autonomos.md), [030](030-receitas-de-conciliacao.md)).

- **Onde**:
  - na **importação** do consolidado: quando a conta tem provisórios ativos, a tela mostra "Substituir o lote provisório <arquivo> (<período>) por este extrato", marcado por padrão para os que se sobrepõem ao período do arquivo; o import grava o lote e faz a troca na mesma transação. A API recebe `supersede=<id>,<id>` e a tool `import_statement`, `supersedeImportIds`;
  - no **detalhe do provisório**: "Substituir pelo consolidado", com a escolha entre os lotes não provisórios da conta que se sobrepõem a ele;
  - no **detalhe do consolidado**: quando há provisório ativo sobreposto, o aviso "Este extrato cobre o período do lote provisório <arquivo>" com o botão "Substituir".
  - Antes de confirmar, a tela mostra a **prévia** (a mesma operação sem gravar): quantas conciliações passam, quantas linhas casam sem conciliação, as sobras de cada lado e os conflitos.

### Casamento das linhas (regra fixa)

Entre as linhas do provisório e as do consolidado ainda não casadas com outra linha provisória:

1. **Data e valor exatos, com correspondência única**: o par entra quando aquele (data, valor) aparece exatamente uma vez em cada lado.
2. **Desempate pela descrição**: nos grupos de (data, valor) que sobraram com mais de uma linha, casam as de descrição normalizada idêntica (a normalização do casamento, `normalizeDescription`), de novo só com correspondência única.

Nada além disso é automático: data deslocada, descrição diferente e valores repetidos no mesmo dia sem desempate ficam para o usuário ou para a IA (abaixo).

### O que acontece com cada linha do provisório

| Linha do provisório | Com par no consolidado | Sem par |
|---|---|---|
| **Conciliada** (`matched`) | **Transferida**: a linha do consolidado passa a conciliada com o **mesmo** movimento (ou o mesmo título baixado), herdando a marca `created_entry`; a linha do provisório solta o vínculo sem tocar no lançamento. | **Pendente**: continua conciliada com o lançamento, aguardando a decisão do usuário. |
| **Ignorada** | **Casada**: a linha do consolidado fica ignorada também, se estava nova. | **Descartada**: nada a fazer. |
| **Nova ou sugerida** | **Casada**: a classificação do usuário (entidade, categoria) passa para a linha do consolidado que não tem classificação do usuário. | **Descartada**: nada a fazer. |

- **Mudar o vínculo, nunca relançar**: a transferência nunca exclui e lança de novo. Títulos, baixas, espelhos, movimentos e a auditoria ficam como estão; só a linha que aponta para eles muda. Por isso a troca funciona também com o lançamento já editado ou com o título baixado parcialmente.
- **Conflito**: a linha do provisório conciliada cujo par no consolidado já está **conciliado com outro lançamento** (o casamento automático da importação achou outro movimento) não transfere; fica **pendente** com o motivo "a linha do consolidado já está conciliada com outro lançamento" (provável lançamento em dobro, que o usuário resolve).
- A linha do consolidado que estava **sugerida** perde a sugestão ao receber a transferência.
- **Sobras do consolidado**: as linhas sem par seguem a conciliação normal da [009](009-extratos-e-conciliacao.md) (já estão no lote como novas, sugeridas ou conciliadas).
- **Resultado** (API, tool e prévia): `transferred`, `paired`, `dropped`, `pending` (com o motivo de cada uma) e `consolidatedLeftover` (as linhas do consolidado sem par), com as contagens.

### O provisório depois da troca

- Fica **substituído**: marcado com o consolidado que o substituiu e o instante, sai da divergência e da lista de pendências da conciliação, e é **somente leitura** (sem casar, lançar, ignorar, classificar, aplicar regras, conciliar com IA, rodar receita, editar o saldo nem excluir). O arquivo, as linhas e o histórico ficam, e cada linha mostra o que aconteceu com ela (transferida, casada, descartada, pendente e as decisões) e o link para a linha do consolidado.
- **Sem desfazer** a troca por enquanto (a auditoria guarda tudo); o consolidado que substituiu outro lote não é excluído.

### Pendências do provisório

A linha conciliada sem par **nunca fica no saldo em silêncio**: o lançamento dela está no saldo do app, mas o banco não o confirmou no consolidado. Enquanto houver uma pendente:

- o detalhe do consolidado mostra o painel **Sobras do provisório** (com a contagem também na lista de lotes), cada uma com o lançamento, a data e o valor, e as ações:
  - **Casar com uma linha do consolidado**: escolhe entre as linhas do consolidado sem par, de **mesmo valor**, ainda não conciliadas (as de data mais próxima primeiro); vira uma transferência;
  - **Manter o lançamento**: a linha solta o vínculo e o lançamento fica, sem linha do banco (o usuário assume a diferença, que aparece na divergência);
  - **Excluir o lançamento** (só quando ele nasceu da linha, `created_entry`): como o "Desfazer e excluir o lançamento" da [009](009-extratos-e-conciliacao.md), na mesma transação; se o lançamento mudou depois, é recusado com `line_entry_changed` e a linha continua pendente;
- o mês da linha pendente **não fecha** (abaixo).

### Sugestão de pares pela IA (opcional)

Para as sobras ambíguas (valores repetidos no mesmo dia, data deslocada de alguns dias, descrição diferente), o botão **"Sugerir pares com IA"** no painel das sobras:

- roda um **fluxo JSON** do agente dos fluxos ([011](011-agentes-de-ia.md)), sem tools, com finalidade própria (`supersede_pairs`): recebe as pendentes do provisório (data, valor, descrição e o lançamento: entidade, categoria, descrição) e as linhas do consolidado sem par e devolve pares com um motivo curto;
- o servidor só aceita o par de **mesmo valor**, com data a até 7 dias, linhas ainda elegíveis e cada linha uma vez; o resto é descartado em silêncio;
- os pares aceitos ficam como **sugestão** na linha pendente (como as sugestões de classificação), e a tela mostra "A IA propõe N pares" com aprovar todas, aprovar as selecionadas ou descartar. Aprovar = casar (a transferência acima); descartar limpa a sugestão;
- passa por `assertCanStartRun` (orçamento e limite dos fluxos, [028](028-limites-e-uso.md)) e grava o uso como qualquer fluxo; sem agente dos fluxos ou sem provedor, o botão avisa e não roda.

O chat e o `/mcp` resolvem as sobras pela tool `resolve_superseded_lines` (abaixo), com o próprio agente escolhendo os pares.

### Conciliar com IA ao importar

- Importar o consolidado **com** a substituição: a troca acontece antes, e a conciliação com IA ao importar (ou as receitas, [029](029-fluxos-autonomos.md)/[030](030-receitas-de-conciliacao.md)) roda só sobre o que sobrou pendente no consolidado.
- Importar um lote não provisório que se sobrepõe a um provisório ativo **sem** a substituição: a conciliação com IA ao importar não roda (`aiReconcile.skipped = 'provisional_overlap'`), para o agente não lançar de novo o que o provisório já conciliou; a tela avisa e oferece a troca.

## Fechamento de mês

- O mês não fecha ([008](008-categorias-auditoria-e-exclusao.md)), **nem com `force`**, enquanto a caixa tem, naquele mês, linha de um **lote provisório ativo** ou linha **pendente** de um provisório substituído (422, `closing_provisional`, com os lotes). A tela de fechamento mostra o motivo com o link para o lote. O banco garante a regra (abaixo).

## API

- `POST /api/statements/import?...&provisional=true&supersede=<id>,<id>`: a resposta traz `superseded` (o resultado da troca, quando houve) e, sem a troca, `provisionalOverlap` (os provisórios ativos sobrepostos).
- `PUT /api/statement-imports/:id/provisional` `{ provisional }`.
- `POST /api/statement-imports/:id/supersede` `{ provisionalImportIds?, dryRun? }`, a partir do consolidado (`provisionalImportIds` omitido = todos os provisórios ativos da conta sobrepostos ao período dele); `dryRun` devolve a prévia sem gravar.
- `GET /api/statement-imports/:id/superseded-lines`: as linhas dos provisórios substituídos por este lote, com o desfecho, o vínculo e a sugestão da IA (filtro `outcome=pending`).
- `POST /api/statement-imports/:id/superseded-lines/resolve` `{ items: [{ lineId, action: 'pair'|'keep'|'delete_entry', consolidatedLineId? }] }`: cada item num savepoint, como o lote de ações da 009 (as que falham voltam em `failed` com o motivo).
- `POST /api/statement-imports/:id/superseded-lines/suggest` (o fluxo de IA) e `POST …/superseded-lines/suggestions` `{ lineIds, decision: 'approve'|'reject' }`.
- O DTO do lote ganha `provisional`, `supersededBy` (`{ id, fileName, at }`), `supersedes` (os lotes que ele substituiu) e `supersedePending` (quantas pendentes); o da linha, `supersedeOutcome`, `supersededByLineId` e a sugestão.
- Todas exigem escrita na caixa da conta (as leituras, leitura).

## Tools ([027](027-tools-de-controle-total.md))

Na categoria **Conciliação**; não entram sozinhas em kit nenhum e ficam no `/mcp`.

- `import_statement` ganha `provisional` e `supersedeImportIds`; a prévia mostra os provisórios ativos sobrepostos e, com a troca, o resultado dela (a operação sem gravar).
- `get_statement_import` e `list_statement_imports` trazem `provisional`, `supersededBy`, `supersedes` e `supersedePending`.
- `set_statement_import_provisional` (escrita, `ask` sugerido): marca ou desmarca.
- `supersede_statement_import` (escrita, `ask` sugerido; prévia = a mesma operação com `dryRun`): `importId` do consolidado e `provisionalImportIds` opcional.
- `resolve_superseded_lines` (escrita, destrutiva quando há `delete_entry`; prévia com o lançamento de cada linha): os mesmos itens do `resolve` da API, até 500.

## Banco (dba)

- **`statement_imports`**: `provisional boolean NOT NULL DEFAULT false`; `superseded_by_import_id` (o lote que o substituiu) e `superseded_at`, preenchidos juntos. Só lote de conta é provisório. Só provisório é substituído, por um lote da mesma conta que não está substituído (o substituto pode ser outro provisório, no parcial mais novo do mesmo mês); um lote não substitui a si mesmo. Substituído é final: `provisional`, `superseded_by_import_id` e `superseded_at` não mudam mais, e o lote não é excluído; o lote que substituiu outro também não. Provisório ativo não se sobrepõe a outro provisório ativo da mesma conta, conferido no COMMIT (a importação do parcial mais novo grava o lote e substitui o anterior na mesma transação). A troca e a marca ficam na auditoria.
- **Deduplicação**: o `dedup_hash` continua único por conta **entre as linhas de lotes não provisórios**; as de lote provisório ficam fora desse índice (o dba escolhe como: coluna repetida na linha, índice parcial ou outro meio), para o consolidado entrar com as mesmas transações. Desmarcar o provisório que repete linhas de outro lote dá `23505`.
- **`statement_lines`**:
  - estado novo `superseded` (sem vínculo, como `new`/`ignored`), só em linha de lote substituído;
  - `superseded_by_line_id` (a linha do consolidado que ficou no lugar: de um lote que substituiu o desta linha, da mesma conta) e `supersede_outcome` (`transferred`, `paired`, `dropped`, `pending`, `kept`, `entry_deleted`), preenchido só em lote substituído; `transferred` e `paired` exigem `superseded_by_line_id`; `pending` exige `matched` e os demais, `superseded`; `pending` só sai para `transferred`, `kept` ou `entry_deleted`, e os outros desfechos são finais;
  - sugestão da IA: `supersede_suggested_line_id` e `supersede_suggestion_reason` (até 500), só em linha `pending`, apontando para uma linha de mesmo valor do lote substituto;
  - linha de lote substituído não muda de outro jeito (status, vínculos, classificação), fora o desfecho acima.
- **Fechamento de mês**: inserir em `period_closings` é recusado (`period_closings_provisional_check`) se uma conta da caixa tem, no mês, linha de lote provisório ativo ou linha `pending`; inserir linha de lote provisório num mês fechado também (`statement_lines_provisional_closed_check`), e marcar como provisório um lote com linha em mês fechado.
- **Divergência**: `statement_import_balances` ganha `provisional` e `superseded` (a aplicação tira os substituídos da divergência e do "lote anterior").
- **IA**: finalidade nova `supersede_pairs` em `ai_conversations.purpose` (fluxo JSON, sem tools) e no `ai_usage.purpose`.
- pgTAP: marca e desmarca, sobreposição, substituição válida e as recusadas (cartão, outra conta, substituto substituído, si mesmo), imutabilidade do substituído e do vínculo, a dedup do provisório e do consolidado, os desfechos e as transições, a sugestão, o fechamento recusado e o provisório em mês fechado.

## Aplicação (app)

- **Serviço** `services/statement-supersede.ts`: `setProvisional`, `supersedeImports(ctx, consolidatedId, { provisionalImportIds, dryRun })` (casamento, transferências, desfechos e o resultado; numa transação, com a trava dos lotes e o `ai_reconcile_import_busy` deles), `listSupersededLines`, `resolveSupersededLines` (reaproveita o `deleteCreatedEntry` da 009) e as sugestões da IA (`suggestSupersedePairs`, fluxo JSON em `ai-flows.ts`, e `decideSupersedeSuggestions`).
- `importStatement`: `provisional`, a dedup que ignora as linhas provisórias (e, no provisório, considera só as não provisórias), a substituição na mesma transação (`supersede`, e automática para o provisório anterior sobreposto) e o `provisionalOverlap`.
- Somente leitura do substituído em `reconciliation.ts` (`loadLine`), `rematchImport`, aplicar regras, conciliação com IA, receitas, editar saldo e excluir lote: 422 `statement_import_superseded`.
- Divergência (`importSql`) e o evento `reconciliation_divergence` sem os substituídos; `closeMonth` traduz o erro do banco e a visão do fechamento mostra os lotes provisórios do mês.
- Tools no registro (`packages/shared/src/agents/tools.ts`, categoria `reconciliation`) e os handlers sobre o serviço; textos em `t` (`i18n/areas/`).
- **Telas** (`apps/web`): a opção na importação e a lista dos provisórios a substituir; os selos na lista de lotes; no detalhe do provisório, marcar/desmarcar e "Substituir pelo consolidado" com a prévia; no detalhe do consolidado, o aviso de provisório sobreposto, o resumo da troca e o painel Sobras do provisório (ações por linha e em lote, "Sugerir pares com IA" e a aprovação em lote); o detalhe do substituído em leitura, com o desfecho por linha.

## Testes

- **Integração** (`test/statement-supersede.test.ts`, contra o Postgres):
  - provisório conciliado (avulso lançado pela linha, título baixado com espelho e baixa num título existente) substituído pelo consolidado: as conciliações passam para as linhas do consolidado com os **mesmos** movimentos, títulos e baixas (nada excluído nem lançado de novo; o número de movimentos da conta não muda) e a marca `created_entry` vai junto;
  - o consolidado importa as linhas repetidas do provisório (dedup) e o provisório deduplica contra os lotes não provisórios;
  - sobras do provisório: conciliada sem par fica `pending` e bloqueia o fechamento do mês (também com `force`); manter, excluir o lançamento e casar à mão resolvem; ignorada e nova sem par viram `dropped`; conflito com a linha do consolidado já conciliada;
  - sobras do consolidado seguem novas/sugeridas;
  - data deslocada: a linha do provisório dois dias antes fica pendente; o fluxo de IA com o provedor falso sugere o par, o servidor recusa o par de valor diferente e o de linha já usada, e aprovar transfere;
  - divergência: depois da troca, o substituído sai e a divergência do intervalo do consolidado é zero (o mesmo saldo do banco e do app);
  - somente leitura do substituído; 409 com conciliação com IA ativa; prévia (`dryRun`) não grava; o parcial mais novo substitui o mais velho na importação; o import sem a troca com provisório sobreposto não dispara a conciliação com IA;
  - as tools `set_statement_import_provisional`, `supersede_statement_import` e `resolve_superseded_lines` (prévia, execução e o `/mcp`).
- **e2e** (`e2e/tests/conciliacao-provisoria.spec.ts`): importar um OFX parcial como provisório, conciliar duas linhas (uma lançada, uma casada com um título), importar o consolidado marcando a substituição, ver as conciliações no consolidado, resolver a sobra do provisório e ver o provisório como substituído, fora da divergência. As contagens de tools da categoria Conciliação em `agentes.spec.ts` sobem com as três tools novas.

## Fora do escopo agora

- Desfazer a substituição.
- Provisório de fatura de cartão.
- Casamento automático por data deslocada ou por descrição parecida (fica para a IA ou para o usuário).
- Aviso no sino das pendências do provisório (a tela do lote, a lista de lotes e o fechamento de mês já mostram).
