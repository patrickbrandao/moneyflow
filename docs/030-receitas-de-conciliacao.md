# 030 — Receitas de conciliação (F16)

Uma **receita de conciliação** é uma instrução reutilizável (o texto enviado como mensagem do usuário) com o **agente responsável** por ela, executada sobre um lote de extrato importado ([009](009-extratos-e-conciliacao.md)) pelo botão **play**, sempre numa **sessão nova**. Ela estende a conciliação completa da [029](029-fluxos-autonomos.md): lá o agente dos fluxos roda uma instrução fixa; aqui cada caso variante ("PIX do condomínio", "tarifas do banco X", "fatura do cartão") tem a sua instrução e o seu agente, em vez de um prompt único que vale para tudo. Decisões de 2026-10-16.

O que é repetitivo e determinístico continua nas **regras de classificação** (gratuitas e previsíveis); a receita fica para o que é ambíguo. Em todas as execuções, **o kit do agente decide** o que roda direto (`allow`) e o que espera aprovação (`ask`), conforme a [021](021-kit-de-ferramentas.md).

## Cadastro

- **Campos**: nome, descrição (opcional), agente, instrução (até 20 mil caracteres, com variáveis), contas vinculadas, "rodar ao importar", ordem e o interruptor ativo.
- **Dona**:
  - uma **caixa** (como as regras de classificação): quem escreve na caixa cria, edita e arquiva; quem lê vê;
  - ou **global** (sem caixa): só o admin cria e edita; vale para os lotes de qualquer caixa.
- **Agente**: qualquer agente ativo, não só o agente dos fluxos. Um agente barato para os casos simples e um forte para os difíceis; um kit só de sugestão (escritas em `ask`) numa receita e um que lança direto em outra. O agente sem kit tem poder completo, e o formulário avisa: "O agente <nome> não tem kit: ele vai lançar sem pedir aprovação".
- **Contas vinculadas**: contas correntes/poupança e cartões da caixa dona (a receita global vincula qualquer uma). Sem vínculo, a receita aparece em todos os lotes da caixa dona (ou em todos, se global); com vínculo, só nos lotes daquelas contas.
- **Rodar ao importar**: só para receitas com contas vinculadas. Vale quando o "Conciliar com IA ao importar" da conta ou do cartão está ligado ([029](029-fluxos-autonomos.md)); a **ordem** define a sequência.
- **Limites**: 50 receitas ativas por caixa (e 50 globais) e 10 com "rodar ao importar" por conta.
- Excluir só arquiva, como o resto do sistema. Receitas são auditadas.

## Variáveis da instrução

- Valem as da [022](022-prompts-e-instrucoes.md) (`{{usuario.nome}}`, `{{data}}`, `{{mes_ano}}`…), no mesmo parser (`prompt-vars.ts`), mais as do lote:
  - `{{lote.id}}`, `{{lote.arquivo}}`, `{{lote.periodo}}` (primeira e última data das linhas, DD/MM/AAAA);
  - `{{conta.nome}}` (conta ou cartão do lote), `{{caixa.nome}}`, `{{caixa.titular}}`;
  - `{{linhas.total}}` (linhas no escopo da execução).
- Variável desconhecida é recusada ao salvar, como no prompt do agente. O formulário lista as variáveis e mostra a instrução renderizada para um lote de exemplo.

## Execução

- **Onde**: na tela do lote, o painel **Receitas** lista as receitas que valem para aquele lote (as vinculadas à conta primeiro, depois as da caixa e as globais), cada uma com o play. A tela de receitas também tem o play, que pede o lote.
- **Escopo**: as **linhas selecionadas** na tela do lote ou, sem seleção, todas as pendentes (`new` e `suggested`). Sem linha no escopo, 422.
- **Quem roda**: quem clicou (ou quem importou, no automático), com as permissões dele e o ator `agent` na auditoria. Exige escrever na caixa do lote e enxergar a receita.
- **Sessão nova**: cada play cria uma conversa `purpose = 'reconcile_statement'` (arquivada, como na [029](029-fluxos-autonomos.md)) com `screen_context` = `{ importId, recipeId, lineIds }`, título "Receita: <nome> (<arquivo>)" e a instrução renderizada como mensagem do usuário. O prompt é o do fluxo de conciliação (`flowSystemPrompt('reconcile_statement')`) com um bloco a mais: o nome da receita, as linhas do escopo e o aviso de que só elas podem ser tocadas.
- **Só tools internas** do kit do agente, sem MCP, no mínimo 60 voltas, como a conciliação da [029](029-fluxos-autonomos.md).
- **Escopo garantido no servidor**: numa execução de receita, as tools de conciliação que recebem uma linha do extrato recusam as linhas fora de `lineIds` ("A linha está fora do escopo desta receita"). A instrução não basta para isso.
- **Uma execução por lote**: enquanto qualquer conversa `reconcile_statement` do lote tem execução ativa (`queued`, `running`, `awaiting_confirmation`), o play responde 409, seja de receita ou da conciliação genérica. A checagem e a criação ficam na mesma transação, com advisory lock pelo lote.
- **Aprovações**: as tools em `ask` viram o lote de aprovações que já existe na tela do lote ("O agente propõe N ações": todas, as selecionadas ou recusar com motivo), agora com o nome da receita. O sino avisa quem disparou (`ai_awaiting_approval`, link para o lote). Só quem disparou decide.
- **Sugestão de regra**: o bloco do prompt pede ao agente que, ao notar um padrão repetitivo e determinístico, proponha uma regra com `create_classification_rule` (que segue o kit; normalmente `ask`). Assim o caso migra da IA para a regra.
- **Limites**: orçamento e limite por minuto dos fluxos ([028](028-limites-e-uso.md)), conferidos por `assertCanStartRun` antes de criar a execução.
- **Fim**: a tela segue o SSE ("A receita <nome> está conciliando…"), recarrega as linhas e mostra o resumo final do agente. Vale o aviso de conclusão de [011](011-agentes-de-ia.md).

## Ao importar

- Com o interruptor da conta ligado:
  - **há receitas** com "rodar ao importar" para a conta: elas rodam **em sequência**, na ordem, cada uma numa sessão nova e com as linhas ainda pendentes no momento em que começa (o que a anterior conciliou já saiu do escopo). A seguinte só começa quando a anterior termina; uma execução esperando aprovação segura a fila até a decisão. Receita sem linha pendente ao chegar a vez dela é pulada (`no_lines`);
  - **não há**: a conciliação genérica do agente dos fluxos, como na [029](029-fluxos-autonomos.md).
- Interruptor desligado: as sugestões de classificação de hoje, como antes.
- Uma falha (erro, orçamento, limite por minuto) marca a execução da receita e a fila segue para a próxima; o sino avisa quem importou.

## Histórico

- Cada execução fica registrada com receita, lote, quem disparou, gatilho (`manual` ou `import`), escopo (número de linhas), status, a sessão e a execução. A tela da receita lista as execuções com link para a sessão (em leitura) e para o lote; a tela do lote mostra as execuções de receitas daquele lote.

## Tela

- **Conciliação → Receitas**: lista com nome, dona (caixa ou global), agente, contas vinculadas, "ao importar", última execução e ativo; formulário com o agente (e o aviso de agente sem kit), a instrução com as variáveis e a prévia renderizada, as contas, "rodar ao importar" e a ordem (arrastar), ativo; histórico de execuções.
- **Tela do lote**: o painel Receitas com o play por receita, o escopo ("12 linhas selecionadas" ou "34 pendentes"), o andamento pelo SSE e o lote de aprovações, que já existe.
- **Cadastro da conta e do cartão**: no "Conciliar com IA ao importar", a lista das receitas que rodam ao importar, na ordem, com link para a tela de receitas.

## Banco (dba)

- **`ai_reconcile_recipes`**: `caixa_id` (nulo = global), `agent_id`, `name`, `description`, `instruction` (até 20 mil), `run_on_import`, `position`, `is_active`, `archived_at`, `created_by_user_id` e os timestamps. Auditada e no backup. Os limites de 50 ativas por dona e de 10 ao importar por conta ficam no banco.
- **`ai_reconcile_recipe_targets`**: (`recipe_id`, `financial_account_id` | `card_caixa_id`), exatamente um dos dois; a conta ou o cartão da caixa dona (qualquer caixa, se a receita é global); `run_on_import` exige pelo menos um alvo (checado no COMMIT). Escolha do dba (tarefa 035): com `id` próprio (o par não cabe numa chave composta, com uma das colunas sempre nula), único por (receita, conta) e (receita, cartão); o cartão de uma receita de caixa é a própria caixa dona ou um cartão cuja pagadora padrão é a dona. No backup.
- **`ai_reconcile_recipe_runs`**: `recipe_id`, `import_id`, `user_id`, `trigger_kind` (`manual|import`), `position` (na fila do import), `line_ids` (uuid[]), `status` (`queued|started|completed|skipped|failed`), `skip_reason`, `conversation_id`, `run_id` e os timestamps. Fora da auditoria e do backup, como `ai_scheduled_task_runs`.
- **Fila do import**: `ai_reconcile_recipe_claim(lote)` reserva a próxima execução `queued` de um lote (`SKIP LOCKED`) só quando nenhuma conversa `reconcile_statement` do lote tem execução ativa (`ai_reconcile_import_busy(lote)`, que o play usa para o 409, com o lock `ai_reconcile_import_lock(lote)`); `ai_reconcile_recipe_pending_imports(limite)` lista os lotes com fila pendente e livres para o worker. Detalhes na [016](016-banco-de-dados.md).
- Sem finalidade nova: as execuções usam `reconcile_statement` em `ai_conversations.purpose` e `ai_usage.purpose`; a receita vem de `screen_context.recipeId`.

## Aplicação (app)

- **Serviço** `services/reconcile-recipes.ts`: CRUD (com `Access`: caixa dona ou admin para as globais), receitas aplicáveis a um lote, `runRecipe(ctx, importId, recipeId, lineIds?)` e a fila do import. `reconcileImportWithAi` passa a enfileirar as receitas quando a conta tem alguma com "rodar ao importar".
- **Runner**: o bloco da receita no prompt e o escopo `lineIds` repassado aos handlers das tools de conciliação, que recusam a linha fora dele.
- **Worker**: no laço de `agents/worker.ts`, ao terminar uma execução de receita de import, reserva e inicia a próxima da fila.
- **API**: `GET/POST /api/reconcile-recipes`, `GET/PATCH/DELETE /api/reconcile-recipes/:id`, `POST …/:id/restore`, `GET …/:id/runs`; `GET /api/statement-imports/:id/recipes` (aplicáveis e execuções do lote) e `POST /api/statement-imports/:id/recipes/:recipeId/run` (`{ lineIds? }`; 409 com execução ativa, 422 sem linhas).
- **Tools** (categoria Conciliação): `list_reconcile_recipes` (allow), `create_reconcile_recipe`, `update_reconcile_recipe`, `archive_reconcile_recipe` e `run_reconcile_recipe` (ask, com prévia: dona, agente, contas e a instrução). Não entram sozinhas em kit nenhum.
- **Backup** ([019](019-backup-e-restauracao.md)): receitas e alvos entram no JSON completo; as execuções ficam fora (`EXCLUDED_TABLES`).
- Textos em `i18n/areas/agents.ts`.

## Testes

- **Integração**:
  - CRUD com permissões: caixa dona, leitor só vê, global só pelo admin; limites; variável desconhecida recusada;
  - play com kit `allow` concilia e lança; com `ask` gera o lote de aprovações com o nome da receita;
  - linha fora do escopo recusada pela tool; sem linhas, 422; segunda execução no mesmo lote, 409;
  - ao importar: duas receitas em sequência (a segunda só com o que sobrou), receita sem linhas pulada, aprovação pendente segurando a fila, falha seguindo para a próxima; sem receitas, a conciliação genérica da 029;
  - roda como quem disparou, com o ator `agent`; orçamento de fluxos estourado não inicia;
  - backup com receitas e alvos.
- **e2e**: criar uma receita com o provedor falso, vincular à conta, importar um OFX, rodar pelo play nas linhas selecionadas e aprovar o lote; e a sequência de duas receitas ao importar.

## Fora do escopo agora

- Receitas agendadas (sem lote): ficam nas tarefas agendadas da [029](029-fluxos-autonomos.md).
- Escolha automática da receita pela IA, filtro de linhas por padrão (descrição, valor) na própria receita e simulação sem efeito (um kit com tudo em `ask` já cumpre esse papel).

## Decisões da implementação (F16)
Entregue na tarefa [036](../tasks/036-receitas-de-conciliacao-na-aplicacao.md) (banco na tarefa 035, migration 0047).

### Serviço e rotas
- Serviço `services/reconcile-recipes.ts`; rotas em `routes/reconcile-recipes.ts`: `GET/POST /api/reconcile-recipes` (filtros `caixaId` — uma caixa ou `global` —, `accountId`, `cardCaixaId`, `archived=true`), `GET/PATCH/DELETE /api/reconcile-recipes/:id` (DELETE arquiva e desliga), `POST …/:id/restore` (desarquiva e liga), `GET …/:id/runs`; `GET /api/statement-imports/:id/recipes` (as receitas que valem para o lote — vinculadas primeiro, depois as da caixa e as globais —, as execuções do lote, as linhas pendentes, `busy` e `canRun`) e `POST /api/statement-imports/:id/recipes/:recipeId/run` (`{ lineIds? }`).
- Vínculos no corpo como `accountIds` e `cardCaixaIds`; no PATCH, a lista dada substitui a atual (a omitida fica). Os limites (50 por dona, 10 ao importar por alvo), a dona da conta/cartão e "rodar ao importar exige vínculo" são do banco, com as mensagens em `DB_CONSTRAINT_MESSAGES`.
- Visibilidade: as globais e as das caixas que o usuário lê; edita quem escreve na caixa dona (globais: só o admin). Alvos de caixas que o usuário não lê não aparecem no DTO.
- Play: exige escrever na caixa do lote; o escopo são as linhas pedidas que ainda estão pendentes (`new`/`suggested`) ou, sem `lineIds`, todas as pendentes; linha de outro lote = 422, escopo vazio = 422 (`nothing_to_reconcile`), receita desligada ou que não vale para o lote = 422. `assertCanStartRun` (fluxos) antes; na transação que cria a sessão e a execução, `ai_reconcile_import_lock` + `ai_reconcile_import_busy` (409 `run_active`). A execução de receita nasce `started` com `line_ids`, `conversation_id` e `run_id`.
- A conciliação genérica (`reconcileImportWithAi`) passou a criar a sessão, a mensagem e a execução numa transação só (`insertReconcileSession`), com o mesmo lock e o mesmo 409.

### Ao importar e o worker
- Com o interruptor ligado, `reconcileImportWithAi({ auto })` enfileira (`enqueueImportRecipes`) as receitas ativas com "rodar ao importar" vinculadas à conta/cartão do lote, de agente ativo, na `position`, como quem importou, e já começa a primeira (`startNextRecipe`); a resposta `aiReconcile` traz `recipes` (quantas) e a execução da primeira. Sem nenhuma, a conciliação genérica da 029. O play manual na tela de "Conciliar com IA" continua genérico.
- Reserva: `ai_reconcile_recipe_claim(lote)`; a transação toma o ator do dono, relê o acesso (sem escrita na caixa do lote = `failed`), calcula as pendentes (nenhuma = `skipped no_lines`), confere o limite por minuto e o orçamento (`skipped rate_limited`/`budget_exceeded`) e cria, num savepoint, a sessão e a execução (erro = `failed` com a mensagem). Pulada ou falha: reserva a seguinte.
- No worker (`agents/worker.ts`), `recipesTick` roda no ritmo da fila de execuções e ao fim de cada execução: fecha as execuções de receita cuja `ai_runs` terminou (`completed`; `failed` com o erro; `canceled` vira `failed` com `canceled`) e chama `startNextRecipe` para cada lote de `ai_reconcile_recipe_pending_imports(20)`. Uma execução esperando aprovação mantém o lote ocupado e segura a fila.

### Runner, prompt e escopo
- Numa conversa `reconcile_statement` com `screen_context.recipeId`, o runner põe o bloco da receita (nome, as linhas do escopo, o aviso de que só elas podem ser tocadas e o pedido de propor regra com `create_classification_rule`) na parte volátil do prompt, depois do prompt fixo da conciliação, e passa `recipeLineIds` no `ServiceContext`.
- O escopo é garantido em `agents/tools-runtime.ts` (`assertRecipeScope`), na prévia e na execução: numa execução de receita, toda tool da categoria Conciliação que cita linhas (`lineId`, `lineIds` e os lotes `matches`/`items`/`suggestions`) recusa a que estiver fora com "A linha está fora do escopo desta receita". Um ponto só, em vez de cada handler.
- A instrução renderizada (variáveis da 022 e as do lote: `lote.id`, `lote.arquivo`, `lote.periodo`, `conta.nome`, `caixa.nome`, `caixa.titular`, `linhas.total`) é a mensagem do usuário. As variáveis ficam em `RECIPE_PROMPT_VARIABLES` (`prompt-vars.ts`, com `scanRecipeVariables`/`renderRecipeVariables`); o schema de entrada recusa a desconhecida (400 com o nome). As do lote não valem no prompt do agente.
- O aviso de aprovação pendente (`ai_awaiting_approval`) leva o nome da receita ("A receita <nome> em <arquivo> espera sua aprovação"); o estado do painel da IA (`GET …/reconcile-ai`) ganhou `recipeName` da execução mais recente.

### Tools, textos e backup
- Tools em `packages/shared/src/agents/recipes.ts` (`RECIPE_TOOLS`, categoria Conciliação) e `agents/tool-handlers-recipes.ts`: `list_reconcile_recipes` (allow), `create_reconcile_recipe`, `update_reconcile_recipe`, `archive_reconcile_recipe` e `run_reconcile_recipe` (ask, prévia com dona, agente, contas, linhas e instrução, e o aviso de agente sem kit). Não entram sozinhas em kit nenhum.
- Textos do servidor em `t.agents.recipes` (`i18n/areas/agents.ts`) e os do console em `t.agentsUi.recipes` (`agents-ui.ts`, como o resto das telas dos agentes). `AgentOptionDto` ganhou `hasKit` (o aviso do formulário).
- Backup: `ai_reconcile_recipe_runs` em `EXCLUDED_TABLES`; receitas e alvos entram no JSON completo, no `DEFERRED_CLUSTER` (o "rodar ao importar exige vínculo" é checado no COMMIT) e os alvos com dono (`OWNED_BY` pela receita).

### Telas
- Conciliação → Receitas: `/reconcile-recipes` (`pages/ReconcileRecipesPage.tsx`, item "Receitas de conciliação" na navegação): ativas e arquivadas, ativo na linha, formulário (dona só na criação, agente com o aviso de agente sem kit, instrução com a lista das variáveis e a prévia num lote de exemplo, contas e cartões, "rodar ao importar", **ordem como campo numérico** em vez de arrastar, ativa) e o histórico com link para o lote e para a sessão.
- Tela do lote: o painel Receitas (`components/reconciliation/RecipesPanel.tsx`) com o play por receita e o escopo ("N linha(s) selecionada(s)" ou "N pendente(s)"; as linhas novas passaram a ser selecionáveis), as execuções do lote e a releitura a cada 4 s enquanto a fila anda. O andamento por SSE e o lote de aprovações são os do painel da conciliação com IA (`ReconcileAiPanel`), remontado a cada execução nova, com o nome da receita.
- Cadastro da conta e do cartão (edição): abaixo de "Conciliar com IA ao importar", a lista das receitas que rodam ao importar, na ordem, com o link para a tela de receitas (`ImportRecipesHint`).

### Simplificado ou fora agora
- O play fica só na tela do lote (a tela de receitas não pede o lote).
- O formulário lista todos os cartões que o usuário lê; o banco recusa o que não for da dona.
- Execução pulada ao importar (sem linhas, orçamento, limite) não gera aviso próprio no sino; a que falha cai no aviso de conclusão comum da 011.
- Testes de integração simples (`test/reconcile-recipes.test.ts`): cadastro e permissão, play com kit `allow` no escopo, linha fora do escopo recusada, 409 com execução ativa e a sequência de duas receitas ao importar. Sem e2e novo (pedido do usuário); os demais casos da seção Testes ficam para depois.
