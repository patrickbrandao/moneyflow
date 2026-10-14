# 029 — Fluxos autônomos dos agentes (F15)

Três fluxos em que o agente trabalha sem alguém digitando no console:

- tarefas agendadas;
- conciliação completa ao importar um extrato;
- conversa pelo Telegram.

Em todos, **o kit do agente decide** o que roda direto (`allow`) e o que espera aprovação (`ask`), conforme a [021](021-kit-de-ferramentas.md). O agente sem kit tem poder completo e não pede nada. Decisões da entrevista de 2026-10-13.

## Tarefas agendadas
- **O que é**: uma tarefa tem dono (usuário), agente, nome, instrução (o texto enviado como mensagem do usuário a cada disparo), agenda e o interruptor ativo.
  - **Agenda**:
    - diária, num horário;
    - semanal, em dias da semana e num horário;
    - mensal, num dia (1–31 ou "último dia") e num horário;
    - sempre no fuso de São Paulo.
- **Quem cria**: o usuário cria as próprias em *Minha conta → Tarefas do agente*. O admin cria para qualquer usuário em /admin/ai.
  - A tarefa roda **como o dono**, com as permissões dele.
  - O limite é de 20 tarefas ativas por usuário.
- **Disparo**:
  - o worker, com advisory lock, dispara as tarefas vencidas (`next_run_at <= agora`), com dedup por (tarefa, horário previsto);
  - um disparo perdido (worker parado) roda uma vez, se o atraso for de até 6 h, e é pulado se for maior, com registro "pulado";
  - cada disparo cria uma **sessão própria** (`purpose = 'scheduled_task'`), fora do fio do chat ([026](026-sessoes-dos-agentes.md)), listada no histórico da tarefa e aberta em leitura (ou para aprovar).
- **Resultado e aprovações**:
  - ao terminar, vale o aviso de conclusão de [011](011-agentes-de-ia.md) (sino e destinos com `agent_completed`), e o agente pode usar `notify_user`/`send_telegram_message` conforme o kit;
  - as escritas em `ask` deixam a execução esperando: o sino avisa "A tarefa <nome> espera sua aprovação" (notificação `ai_awaiting_approval`) com link, e a confirmação expira em 7 dias, como hoje;
  - a tarefa não dispara de novo enquanto a execução anterior estiver ativa (o disparo vira "pulado: execução anterior em andamento").
- **Limites**: entram no orçamento de fluxos e no limite por minuto de fluxos ([028](028-limites-e-uso.md)).
- **Tela**:
  - a lista mostra nome, agente, agenda em texto ("toda segunda às 08:00"), próximo disparo, último resultado e ativo;
  - o formulário tem o agente, a instrução, a agenda e "Rodar agora";
  - o histórico mostra os disparos, com status e link para a sessão.

## Conciliação completa ao importar
- **Liga e desliga**:
  - por conta corrente/poupança e por cartão, o interruptor **"Conciliar com IA ao importar"** (desligado por padrão), no cadastro da conta e na tela do lote;
  - o botão **"Conciliar com IA"** na tela do lote dispara sob demanda.
- **O que faz**: o agente dos fluxos ([011](011-agentes-de-ia.md)) roda numa conversa de fluxo `purpose = 'reconcile_statement'`, **com as tools do kit dele**. Até aqui os fluxos rodavam sem tools. O agente faz o mesmo que um agente sem confirmação faz hoje:
  - localiza os candidatos (`list_line_candidates`);
  - casa com movimentos e títulos;
  - lança as linhas novas (com espelho e pagadora);
  - ignora tarifas conforme as regras;
  - corrige casamentos errados (desfazer e estornar).
  - Quando o interruptor está desligado, as **sugestões** de classificação de hoje continuam como estão.
- **Ator**: roda como o usuário que importou (ou que clicou), com as permissões dele e o ator `agent` na auditoria.
- **Aprovações em lote**: as tools em `ask` viram confirmações pendentes. A tela do lote mostra "O agente propõe N ações", com a prévia de cada uma, e permite aprovar todas, aprovar as selecionadas ou recusar com motivo. O sino avisa quem importou.
- **Só tools internas**: a conciliação usa só as tools internas do kit (as de MCP externo não entram); as tarefas agendadas e o Telegram usam também os MCP do agente, que seguem a regra deles (pedem confirmação, salvo `readOnlyHint`).
- **Sem kit**: o agente dos fluxos sem kit concilia e publica tudo sozinho. A tela do interruptor avisa: "O agente dos fluxos não tem kit: ele vai lançar sem pedir aprovação".
- A tela do lote segue o SSE da execução ("O agente está conciliando…") e recarrega as linhas ao fim, como já faz com as sugestões.

## Responder pelo Telegram
- **Entrada por webhook**:
  - o destino Telegram de [013](013-mensagens-telegram.md) ganha **"Receber mensagens"**, com o **agente** que responde;
  - ao ligar, a aplicação chama `setWebhook` com a URL pública (`telegram.public_base_url`, que vence `PUBLIC_BASE_URL`) + `/api/telegram/webhook/:destinationId` e um `secret_token` aleatório;
  - o webhook exige a URL pública com HTTPS (sem ela, o interruptor fica desabilitado com a explicação);
  - ao desligar, `deleteWebhook`.
  - O webhook recusa (401) a chamada sem o cabeçalho `X-Telegram-Bot-Api-Secret-Token` correto e deduplica por `update_id`.
- **Pareamento**:
  - em *Minha conta → Telegram*, o usuário escolhe um destino com entrada ligada que ele pode usar (pessoal, de caixa que ele lê, ou global) e recebe um **código de uso único** (8 caracteres, válido por 10 min);
  - enviar `/start <código>` ao bot liga aquele chat privado ao usuário;
  - só chats privados;
  - um chat não pareado recebe "Este chat não está pareado com o MoneyFlow";
  - o usuário vê e desfaz os pareamentos, e o admin vê todos.
- **Conversa**:
  - a mensagem do chat pareado entra na **sessão ativa** do usuário com o agente do destino ([026](026-sessoes-dos-agentes.md)), que é o mesmo fio do console;
  - a resposta final do agente volta ao chat (markdown convertido para o HTML do Telegram, em partes de 4096 caracteres);
  - o "digitando…" (`sendChatAction`) fica ativo enquanto a execução roda.
- **Mídia**:
  - nota de voz e áudio são transcritos ([025](025-chat-multimidia.md));
  - fotos e documentos viram anexos, até 20 MB, o limite de download da Bot API;
  - um agente sem a capacidade avisa o que não conseguiu ler.
- **Aprovações**: cada tool em `ask` chega como mensagem com a prévia resumida e botões inline **Aprovar** / **Recusar** (`callback_query`). Recusar pede o motivo na mensagem seguinte (opcional: "pular"). A mesma confirmação também aparece no console, e quem decidir primeiro vale.
- **Execução em andamento**: uma mensagem que chega com a execução anterior ainda rodando recebe "Ainda estou trabalhando na anterior: aguarde ou envie /parar" e não é enviada ao agente.
- **Segredos**: as tools de segredo ([027](027-tools-de-controle-total.md)) não são aprovadas pelo Telegram ("abra o console para digitar o segredo").
- **Comandos**:
  - `/nova`: finaliza a sessão;
  - `/parar`: para a execução;
  - `/agente`: mostra o agente e a sessão;
  - `/ajuda`.
- **Limites**: o orçamento e o limite por minuto do usuário ([028](028-limites-e-uso.md)).

## Banco (dba)
- **`ai_scheduled_tasks`**:
  - colunas: `user_id`, `agent_id`, `name`, `instruction` (até 20 mil), `schedule` (jsonb validado: `kind daily|weekly|monthly`, `time`, `weekdays`, `day`), `is_active`, `next_run_at`, `last_run_at`, `created_by_user_id` e os timestamps;
  - auditada e no backup.
- **`ai_scheduled_task_runs`**: `task_id`, `scheduled_for`, `status` (`started|skipped|failed`), `skip_reason`, `conversation_id` e `run_id`; único por (`task_id`, `scheduled_for`).
- **Claim**: `ai_scheduled_task_claim(limite, atraso_máximo = 6 h)` com `SKIP LOCKED` (vários disparos perdidos viram um, o mais recente; acima do atraso, `skipped` com `missed_window`; também `skipped` com `previous_run_active`, `user_inactive` ou `agent_inactive`) e `ai_scheduled_task_run_now(tarefa)` ("Rodar agora", `trigger_kind = manual`, vale para a tarefa desligada e não muda o próximo disparo).
- **Escolhas do dba** (tarefa 032): `next_run_at` é **calculado pelo banco** (`ai_schedule_next_run`/`ai_schedule_prev_run`, fuso de São Paulo; dia que o mês não tem = último dia; trigger ao criar, ligar ou mudar a agenda, nulo se desligada) e o **limite de 20 ativas** também é do banco (`ai_scheduled_tasks_active_limit_check`); a agenda é `{"kind": "daily", "time"}`, `{"kind": "weekly", "time", "weekdays": [1–7, ISO]}` ou `{"kind": "monthly", "time", "day": 1–31 | "last"}` (`ai_schedule_valid`); o disparo tem `trigger_kind` (`schedule|manual`) e o motivo em `skip_reason` (os da aplicação: `budget_exceeded`, `rate_limited` ou a mensagem de erro); `ai_scheduled_task_runs` fica fora da auditoria e do backup; a coluna do segredo chama-se `webhook_secret_hash`.
- **Novas finalidades** em `ai_conversations.purpose` e `ai_usage.purpose`: `scheduled_task` e `reconcile_statement`.
- **`ai_auto_reconcile`** (`boolean NOT NULL DEFAULT false`) em `financial_accounts` e em `caixas`, nesta só com `kind = 'credit_card'` (CHECK).
- **`message_destinations`**:
  - entram `inbound_enabled`, `inbound_agent_id` e `webhook_secret_hash` (com `GRANT SELECT` explícito nas colunas novas legíveis; o hash do segredo não é legível, como o `bot_token`);
  - um bot só aceita um webhook: índice único em `bot_id` entre os destinos com `inbound_enabled`;
  - o `webhook_secret_hash` entra na lista de segredos que a auditoria nunca grava e ganha o leitor `admin_message_destination_webhook_secret(destino, ator)` para o backup; a importação do backup traz o destino com `inbound_enabled = false` (o webhook é de outra instância e precisa ser religado);
  - o segredo é write-only como o `bot_token`: o banco guarda só o SHA-256 (`webhook_secret_hash`), conferido pela função `SECURITY DEFINER` `telegram_webhook_authenticate(destino, segredo)`;
  - entrada ligada exige destino ativo, o agente e o hash (`message_destinations_inbound_check`): desativar ou arquivar o destino desliga a entrada no mesmo UPDATE;
  - o token do bot para a entrada (`setWebhook`/`deleteWebhook`, respostas, botões, `getFile`) é lido por `telegram_inbound_bot_token(destino)` (`SECURITY DEFINER`; só destino ativo, não arquivado e com o hash gravado, inclusive na mesma transação que liga a entrada; tarefa [034](../tasks/034-token-do-bot-para-a-entrada-do-telegram.md)).
- **Pareamento**:
  - `telegram_links`: `destination_id`, `user_id`, `chat_id`, `telegram_user_id`, `username`, `created_at` e `revoked_at`; único por (destino, chat) ativo;
  - `telegram_pairing_codes`: hash do código, usuário, destino, expiração e uso.
  - Os dois são auditados, e no backup só os vínculos.
- **`telegram_updates_seen`**: (`destination_id`, `update_id`), para a dedup, purgada em 7 dias.
- **Notificação e mensagens**: um tipo de notificação `ai_awaiting_approval` (tarefas agendadas e conciliação) e o evento correspondente.
- **`app_settings`**: chave `telegram.public_base_url` (opcional; vence `PUBLIC_BASE_URL`).

## Aplicação (app)
- **Tools de agente** (categoria Configuração de IA, [027](027-tools-de-controle-total.md)): `list_agent_tasks`, `create_agent_task`, `update_agent_task`, `delete_agent_task`, `run_agent_task_now` (o usuário para as próprias; o admin para qualquer um).
- **Worker**: o laço das tarefas agendadas; a conciliação disparada no fim do import (fila); o envio das respostas e dos botões ao Telegram.
- **API**:
  - `POST /api/telegram/webhook/:destinationId` (sem sessão, autenticado pelo segredo);
  - pareamento em `/api/account/telegram`;
  - tarefas em `/api/account/agent-tasks` e `/api/admin/ai/agent-tasks`;
  - "Conciliar com IA" em `/api/statement-imports/:id/reconcile-ai`;
  - aprovação em lote reaproveitando `ai_tool_confirmations_decide`.
- **Integração Telegram**: `setWebhook`, `deleteWebhook`, `sendChatAction`, `answerCallbackQuery`, `getFile` e o download, em `integrations/telegram.ts`. A Bot API falsa dos e2e ganha esses métodos.

## Testes
- **Integração**:
  - **Tarefas**: disparo único por horário, atraso de até 6 h roda, acima disso pula; pula com execução ativa; `ask` deixa aguardando e avisa; orçamento de fluxos estourado pula.
  - **Conciliação**: com kit `allow` concilia e lança; com `ask` gera o lote de confirmações; desligado mantém as sugestões; roda como quem importou.
  - **Telegram**: segredo errado dá 401; `update_id` repetido é ignorado; chat não pareado recebe o aviso; o código expira e é de uso único; a mensagem entra na sessão ativa do console; a nota de voz é transcrita; o botão Aprovar decide a confirmação.
- **e2e**:
  - criar uma tarefa com "Rodar agora" e aprovar no sino;
  - importar OFX com "Conciliar com IA" e aprovar o lote;
  - parear o Telegram com a Bot API falsa e trocar mensagens.

## Decisões da implementação (F15)
Entregue na tarefa [033](../tasks/033-fluxos-autonomos-na-aplicacao.md) (banco nas tarefas 032 e 034).

### Tarefas agendadas
- Serviço `services/agent-tasks.ts`; rotas `/api/account/agent-tasks` (as próprias; o dono é sempre quem cria) e `/api/admin/ai/agent-tasks` (só admin, de qualquer usuário, com `userId`), cada uma com `/:id/runs` (histórico) e `/:id/run` ("Rodar agora").
- O laço do worker (`AGENT_TASK_INTERVAL_MS`, padrão 30 s) reserva uma tarefa vencida por transação e, **na mesma transação da reserva**, confere o limite por minuto e o orçamento dos fluxos do dono (o admin dono fica isento do orçamento, como no resto) e cria, num savepoint, a sessão própria (`purpose = 'scheduled_task'`, arquivada, título "Tarefa: <nome> (<data>)"), a mensagem com a instrução e a execução, gravando `conversation_id` e `run_id` no disparo. Não deu para começar: o disparo fica `skipped` (`rate_limited`, `budget_exceeded`) ou `failed` (o erro), sem desfazer a reserva. O "Rodar agora" faz o mesmo na transação de `ai_scheduled_task_run_now`; a execução é sempre do dono, mesmo quando o admin clica.
- A execução usa o loop normal com as tools internas do kit e os MCP do agente; o prompt é o do chat (instruções do usuário e as do MCP) com um bloco dizendo que é uma tarefa agendada sem ninguém acompanhando. A sessão não entra no fio do chat e abre em leitura no console (sem composer), com o cartão de aprovação para o dono.
- `ask` deixa a execução em `awaiting_confirmation` e o worker cria a notificação `ai_awaiting_approval` ("A tarefa <nome> espera sua aprovação", link `/?conversation=<sessão>`) e o evento para os destinos; o aviso comum de "aguarda confirmação" (`agent_completed`) não é duplicado nesses fluxos. Ao terminar, vale o aviso de conclusão de [011](011-agentes-de-ia.md).
- Tela: Minha conta → Tarefas do agente e /admin/ai → Tarefas e Telegram (lista com agenda em texto, próximo disparo, último resultado e ativo; formulário; histórico com link para a sessão; "Rodar agora").

### Conciliação completa ao importar
- O interruptor fica em `financial_accounts.ai_auto_reconcile` (corrente e poupança) e `caixas.ai_auto_reconcile` (cartão): no cadastro da conta e do cartão (edição) e no painel "Conciliação com IA" da tela do lote (`PUT /api/statement-imports/:id/reconcile-ai/auto`).
- Ligado, o import enfileira a conciliação (resposta `aiReconcile`) em vez das sugestões de classificação; desligado, as sugestões seguem como antes (`aiSuggestion`). "Conciliar com IA" (`POST /api/statement-imports/:id/reconcile-ai`) dispara sob demanda (409 com uma execução ativa no lote); `GET` devolve o interruptor, o agente dos fluxos (com `hasKit`), a execução mais recente e as confirmações pendentes.
- A conversa `reconcile_statement` (arquivada, `screen_context.importId`) roda como quem importou (ou clicou), com o ator `agent` na auditoria, **só com as tools internas** do kit do agente dos fluxos (sem MCP) e no mínimo 60 voltas (um lote tem muitas linhas). A mensagem pede ler o lote (`get_statement_import`), os candidatos (`list_line_candidates`), casar, lançar, ignorar tarifas e corrigir casamentos errados.
- Aprovação em lote na tela do lote ("O agente propõe N ações"): todas, as selecionadas, ou recusar com motivo, por `POST /api/runs/:id/confirmations` (`ai_tool_confirmations_decide`); só quem disparou decide, os demais leitores veem. O sino avisa quem importou (`ai_awaiting_approval`, link para o lote). A tela segue o SSE ("O agente está conciliando…") e recarrega as linhas ao fim.

### Telegram de entrada
- "Receber mensagens" e o webhook: ver [013](013-mensagens-telegram.md), seção *Entrada*. A URL pública vem de `telegram.public_base_url` (/admin/ai → Tarefas e Telegram) ou `PUBLIC_BASE_URL`, e só vale com HTTPS.
- `POST /api/telegram/webhook/:destinationId` fica fora da sessão por cookie: 401 sem o cabeçalho certo (`telegram_webhook_authenticate`), `update_id` repetido ignorado (`telegram_update_seen`; se o processamento falhar, a marca é apagada e o Telegram reentrega), purga de 7 dias na manutenção do worker.
- Pareamento em Minha conta → Telegram (`/api/account/telegram`, `POST /api/account/telegram/pairing-codes`, `DELETE /api/account/telegram/links/:id`; o admin vê todos com `?all=true`): código de 8 caracteres sem os ambíguos (0/O, 1/I/L), 10 min, uso único, só o hash no banco (`telegram_pairing_code_create`/`telegram_pairing_consume`). `/start <código>` em chat privado pareia; grupos e canais são ignorados; chat não pareado recebe o aviso. O usuário precisa continuar podendo usar o destino (pessoal dele, de caixa que ele lê, ou global).
- A mensagem entra na sessão ativa do usuário com o agente do destino (`sendToAgent`, como o próprio usuário, com o limite por minuto e o orçamento dele). A execução nasce com o evento interno `telegram`/`origin` (destino e chat), na mesma transação: o worker mantém o `sendChatAction` a cada 4 s enquanto roda e, ao parar, manda a resposta final (markdown → HTML do Telegram, `markdownToTelegramHtml` em `@moneyflow/shared`, partes de até 4096 sem cortar tags; HTML recusado vai como texto puro) ou os cartões das confirmações com os botões **Aprovar**/**Recusar** (`callback_data` `ok:<id>`/`no:<id>`). O que já foi ao chat fica marcado em eventos `telegram`/`sent` e não se repete. As respostas vão direto pela Bot API, fora da outbox.
- Recusar grava o evento `reason_requested`; a mensagem seguinte do chat é o motivo ("pular" = sem motivo) e decide a recusa. Aprovar e recusar usam `decideConfirmations` como o dono; a mesma confirmação aparece no console e quem decide primeiro vale ("Esta ação já foi decidida"). Tool de segredo: só o botão Recusar e o aviso "abra o console para digitar o segredo".
- Com uma execução ativa na sessão, a mensagem recebe "Ainda estou trabalhando na anterior: aguarde ou envie /parar" (ou, esperando aprovação, o pedido de responder pelos botões) e não vai ao agente.
- Mídia: voz e áudio baixados (`getFile` e o download, até 20 MB) viram anexos da sessão com a transcrição enfileirada ([025](025-chat-multimidia.md)); foto (o maior tamanho) e documento viram anexos; agente sem áudio→texto recebe "O agente não transcreve áudio" e nada vai a ele; anexo recusado (ex.: imagem sem visão) devolve "Não consegui ler o anexo: <motivo>".
- Comandos: `/nova` (finaliza a sessão), `/parar` (cancela a execução ativa), `/agente` (agente, sessão e mensagens), `/ajuda` (também `/start` sem código num chat pareado).
- Serviço `services/telegram-inbound.ts`; integração `integrations/telegram.ts` (`botApiCall`, `sendChatMessage`, `setWebhook`, `deleteWebhook`, `sendChatAction`, `answerCallbackQuery`, `getFile`, `downloadFile`); a Bot API falsa dos testes e e2e é `e2e/fakes/fake-telegram.ts`.

### Tools e backup
- Tools da categoria Configuração de IA, sem `adminOnly`: `list_agent_tasks` (allow; `userId`/`all` só para o admin), `create_agent_task`, `update_agent_task`, `delete_agent_task` e `run_agent_task_now` (ask, com prévia: dono, agente, agenda em texto e instrução); o usuário só as próprias, o admin as de qualquer um (o serviço confere).
- Backup: `SECRET_READERS` do destino leva o `bot_token` e o `webhook_secret_hash`; `ai_scheduled_task_runs`, `telegram_pairing_codes` e `telegram_updates_seen` ficam fora (`EXCLUDED_TABLES`); `ai_scheduled_tasks` e `telegram_links` vão. A importação traz o destino com `inbound_enabled = false` e a tarefa com o próximo disparo recalculado pelo banco.
