---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit:
---

# Tarefas agendadas, conciliação completa ao importar e conversa pelo Telegram (F15)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [029](../docs/029-fluxos-autonomos.md), seção "Aplicação (app)". O que fazer: Laço das tarefas no worker e telas (Minha conta e admin), conciliação com as tools do kit do agente dos fluxos e aprovação em lote na tela do lote, webhook do Telegram (`setWebhook`, segredo, dedup), pareamento por código, sessão ativa compartilhada com o console, mídia, botões de aprovação, comandos; Bot API falsa estendida; testes e e2e.

Ordem: Depois da 032. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [029](../docs/029-fluxos-autonomos.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **Worker**: `src/worker.ts` e `agents/worker.ts`, com o laço das tarefas sob advisory lock, mais um serviço novo de tarefas.
- **`services/statements.ts`**: o import dispara a conciliação.
- **Fluxos**: `services/ai-flows.ts` e `agents/flows.ts`.
- **`runner.ts`**: hoje toda finalidade de `FLOW_PURPOSES` roda sem tools e sem MCP, com uma iteração, e termina em `applyFlowResult` (l. 124–146, 150 e 211–215). É preciso separar o "fluxo JSON" do "fluxo com tools" (`scheduled_task`, `reconcile_statement`).
- **`integrations/telegram.ts`**: hoje só tem `sendTelegramMessage`/`redactToken`. Ganha `setWebhook`, `deleteWebhook`, `sendChatAction`, `answerCallbackQuery`, `getFile` e o download.
- **Rota nova** `POST /api/telegram/webhook/:destinationId`, fora da sessão por cookie.
- **Mensagens**: `services/messages.ts` e `services/message-worker.ts`.
- **Web**:
  - Minha conta: tarefas e Telegram;
  - /admin/ai: tarefas;
  - a tela do lote, com a aprovação em lote;
  - o cadastro de conta e de cartão.
- **Bot API falsa dos e2e**: os métodos novos.
- **Variável nova** `PUBLIC_BASE_URL`, que não existe hoje, em `.env.example` e no compose.
- **Banco**: `pnpm db:pull` depois da 032.

**Riscos e observações**
- O webhook exige HTTPS público. No e2e, a Bot API falsa chama o webhook direto.
- Com uma execução ativa na sessão, a mensagem do Telegram cai no 409 do `sendMessage` (`ai_runs_conversation_active_key`).
- `ai_tool_confirmations_decide` exige que quem decide seja o usuário da execução. Funciona no Telegram (o chat pareado leva ao usuário) e nas tarefas criadas pelo admin para outro usuário, porque quem decide é o dono.

**Dependências**
- Depende da 032.
- Também do kit (017), das sessões (027), da transcrição (025) e dos limites (031).

**Como verificar**
- Os testes da 029: tarefas, conciliação e Telegram.
- Os três e2e.

**Pontos para a revisão da spec**
1. (029, Telegram/Conversa) Falta o que fazer quando chega mensagem com uma execução ativa na sessão. Recomendação: responder "aguarde a resposta atual ou use /parar", sem enfileirar.
2. (029 × 021) "O agente sem kit … não pede nada", mas as tools MCP externas continuam pedindo confirmação (021), e os fluxos de hoje rodam sem MCP. Recomendação: tarefas agendadas e Telegram com MCP, como o chat e com a regra de confirmação do MCP; a conciliação só com as tools internas.
3. (029, Notificações) Não está claro se a aprovação pendente da conciliação usa o `agent_completed` de hoje ou o tipo novo `ai_task_awaiting_approval`. Recomendação: um único tipo novo para tarefas e conciliação, chamado `ai_awaiting_approval`.

## Resolução (executor)
Feito pelo agente de aplicação em 2026-10-14 (sem commit; a sessão principal commita). A spec [029](../docs/029-fluxos-autonomos.md) ganhou a seção "Decisões da implementação (F15)", com o nome real da coluna (`webhook_secret_hash`) e as escolhas do dba da 032.

**Banco**
- `pnpm db:pull` depois da 0045.
- Faltava um jeito de ler o token do bot fora da outbox: `setWebhook`, `deleteWebhook`, respostas ao chat privado, botões, `getFile`, "digitando…".
  - Abri a tarefa [034](034-token-do-bot-para-a-entrada-do-telegram.md) para o dba.
  - A 0046 criou `telegram_inbound_bot_token(destino)`, que devolve o token só de destino ativo, não arquivado e com o hash gravado.
- Mandar as respostas pela outbox não serve: ela entrega no chat do destino, e o histórico mostraria a conversa privada de outro usuário a quem gerencia um destino de caixa.

**Tarefas agendadas**
- `services/agent-tasks.ts`:
  - CRUD do dono (`/api/account/agent-tasks`) e do admin (`/api/admin/ai/agent-tasks`), com histórico (`/:id/runs`) e "Rodar agora" (`/:id/run`).
  - `tasksTick` no laço do worker (`AGENT_TASK_INTERVAL_MS`, padrão 30 s).
- Na mesma transação da reserva (`ai_scheduled_task_claim` ou `ai_scheduled_task_run_now`):
  - confere o limite por minuto e o orçamento de fluxos do dono;
  - num savepoint, cria a sessão `scheduled_task` (arquivada), a mensagem e a execução, e liga as duas ao disparo;
  - se não começa, o disparo fica `skipped` (`rate_limited`, `budget_exceeded`) ou `failed`.
- `next_run_at` vem do banco.
- O runner separa o fluxo JSON do fluxo com tools (`TOOL_FLOW_PURPOSES`):
  - a tarefa roda com as tools do kit e os MCP, com o prompt do chat e o aviso de que ninguém acompanha;
  - o `ask` deixa a execução aguardando, e o worker cria `ai_awaiting_approval` (`services/autonomous-notify.ts`), com sino e destinos;
  - o hub não duplica o aviso de espera.
- Tools `list_agent_tasks` (allow) e `create/update/delete_agent_task` e `run_agent_task_now` (ask, com prévia): o usuário as próprias, o admin as de qualquer um.
- Telas:
  - Minha conta → Tarefas do agente e /admin/ai → Tarefas e Telegram: lista, formulário, histórico com "Abrir a sessão" e "Rodar agora";
  - a sessão de fluxo abre no console sem composer, mas com o cartão de aprovação (`ConversationDto.purpose`).

**Conciliação completa ao importar**
- `ai_auto_reconcile` fica na conta (corrente e poupança) e no cartão. Edita-se no cadastro e no painel "Conciliação com IA" da tela do lote: `PUT /api/statement-imports/:id/reconcile-ai/auto`.
- Com o interruptor ligado, o import enfileira a conciliação (`aiReconcile`); desligado, mantém as sugestões (`aiSuggestion`).
- "Conciliar com IA" é `POST /api/statement-imports/:id/reconcile-ai` (409 com uma execução ativa). O `GET` traz o estado, o agente (`hasKit`, para o aviso "sem kit") e as confirmações.
- A conversa `reconcile_statement` roda como quem importou, só com as tools internas do kit, com no mínimo 60 voltas.
- Na tela do lote, "O agente propõe N ações": aprovar todas, aprovar as selecionadas ou recusar com motivo, por `POST /api/runs/:id/confirmations`. A tela segue o SSE ("O agente está conciliando…").

**Telegram de entrada** (`services/telegram-inbound.ts`, `routes/telegram.ts`, `integrations/telegram.ts`)
- **Ligar e desligar**:
  - "Receber mensagens" fica na edição do destino. Ligar grava a entrada e o hash de um segredo novo e chama `setWebhook` na mesma transação; se o Telegram recusa, nada muda.
  - Desligar, desativar ou arquivar desliga no mesmo UPDATE e chama `deleteWebhook`. Trocar o token religa o webhook no bot novo.
  - A URL pública vem de `telegram.public_base_url` (na tela) ou de `PUBLIC_BASE_URL`, só com HTTPS. Entrou no `.env.example` e no compose.
- **Webhook**:
  - sem sessão; 401 com o segredo errado ou ausente;
  - `update_id` repetido é ignorado; se o processamento falha, a marca sai e o Telegram reentrega;
  - purga de 7 dias na manutenção.
- **Pareamento**: código de 8 caracteres em Minha conta → Telegram e `/start <código>`, só em chat privado. O chat não pareado recebe o aviso. O usuário desfaz o pareamento, e o admin vê todos.
- **Conversa**:
  - entra na sessão ativa do console (`sendToAgent`, como o usuário);
  - a execução nasce com o evento `telegram/origin` na mesma transação, e o worker mantém o `sendChatAction` e manda a resposta em HTML do Telegram (`markdownToTelegramHtml`, partes de até 4096);
  - o que já foi enviado fica marcado em eventos `telegram/sent`;
  - com a execução anterior ativa, a mensagem recebe "aguarde ou /parar".
- **Botões**:
  - Aprovar e Recusar; recusar pede o motivo na mensagem seguinte ("pular" = sem motivo);
  - quem decide primeiro vale;
  - a tool de segredo manda abrir o console.
- **Mídia**: voz transcrita, foto e documento como anexos (até 20 MB). O agente sem áudio→texto avisa.
- **Comandos**: `/nova`, `/parar`, `/agente` e `/ajuda`.
- A Bot API falsa (`e2e/fakes/fake-telegram.ts`), compartilhada pela integração e pelo e2e, ganhou `setWebhook`, `deleteWebhook`, `sendChatAction`, `answerCallbackQuery`, `getFile` e o download.

**Backup**
- `SECRET_READERS` virou uma lista por tabela; o destino leva `bot_token` e `webhook_secret_hash`.
- `ai_scheduled_task_runs`, `telegram_pairing_codes` e `telegram_updates_seen` entraram em `EXCLUDED_TABLES`.
- A importação traz o destino com `inbound_enabled = false`.

**Testes**
- **Integração**: `apps/server/test/autonomous.test.ts`, 17 casos.
  - Tarefas: cadastro e permissões; disparo único por horário; atraso de até 6 h roda e acima pula; pula com a execução ativa; "Rodar agora" do dono e do admin; `ask` aguardando com o sino e aprovado; orçamento de fluxos pula; as tools.
  - Conciliação: desligada mantém as sugestões; kit `allow` concilia e lança como quem importou (ator `agent`); `ask` gera o lote, com as selecionadas aprovadas e o resto recusado com motivo, e o sino.
  - Telegram: `setWebhook` com o segredo (e a recusa); segredo errado dá 401; dedup; chat não pareado; grupo; código de uso único e expirado; sessão ativa do console com "digitando…" e "aguarde"; Aprovar e Recusar com motivo; comandos; voz transcrita, foto e agente sem transcrição; desfazer o pareamento e desativar com `deleteWebhook`.
  - Em `backup.test.ts`, o caso "fluxos autônomos (spec 029)".
- **Unitários**: `packages/shared/test/autonomous.test.ts` (agenda e HTML do Telegram) e o registro de tools em `agents.test.ts`.
- **e2e** (pilha com `TELEGRAM_API_BASE=http://host.docker.internal:18081`):
  - em `agentes.spec.ts`, a tarefa com "Rodar agora" aprovada pelo sino e o OFX com "Conciliar com IA" e o lote aprovado;
  - em `visao.spec.ts`, ligar a entrada, parear pela tela e trocar mensagens, com a Bot API falsa e um provedor falso próprio na 18083; o webhook é chamado direto pelo teste.

**Verificações**
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 141, integração 212, contra o banco de teste recriado e migrado até a 0046) e `pnpm build` passaram.
- e2e: `agentes.spec.ts` e `visao.spec.ts` inteiros, 25 passaram. A pilha foi parada no fim.

**Specs**: [029](../docs/029-fluxos-autonomos.md), [011](../docs/011-agentes-de-ia.md) (F15 entregue), [013](../docs/013-mensagens-telegram.md) (Entrada e `ai_awaiting_approval`), [INDEX](../docs/INDEX.md) e o `AGENTS.md`.
