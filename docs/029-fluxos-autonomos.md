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
  - ao ligar, a aplicação chama `setWebhook` com `PUBLIC_BASE_URL` + `/api/telegram/webhook/:destinationId` e um `secret_token` aleatório;
  - o webhook exige `PUBLIC_BASE_URL` com HTTPS (sem ela, o interruptor fica desabilitado com a explicação);
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
- **Claim**: uma função de claim com `SKIP LOCKED`, e o cálculo de `next_run_at` no fuso de São Paulo, na aplicação ou no banco (escolha do dba, com testes).
- **Novas finalidades** em `ai_conversations.purpose` e `ai_usage.purpose`: `scheduled_task` e `reconcile_statement`.
- **`ai_auto_reconcile`** (`boolean NOT NULL DEFAULT false`) em `financial_accounts` e em `caixas`, nesta só com `kind = 'credit_card'` (CHECK).
- **`message_destinations`**:
  - entram `inbound_enabled`, `inbound_agent_id` e `webhook_secret` (com `GRANT SELECT` explícito nas colunas novas legíveis; o segredo não é legível, como o `bot_token`);
  - um bot só aceita um webhook: índice único em `bot_id` entre os destinos com `inbound_enabled`;
  - o `webhook_secret` entra na lista de segredos que a auditoria nunca grava e ganha o leitor `admin_message_destination_webhook_secret(destino, ator)` para o backup; a importação do backup traz o destino com `inbound_enabled = false` (o webhook é de outra instância e precisa ser religado);
  - o `webhook_secret` é write-only como o `bot_token`, guardado como hash, com a checagem por função `SECURITY DEFINER` `telegram_webhook_authenticate(destino, segredo)`.
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
