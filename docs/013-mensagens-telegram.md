# 013 — Mensagens (Telegram)

- **Cadastro central de destinos Telegram**: token do bot + chat_id (pessoa ou grupo), com vários bots/contas. Cada destino escolhe quais eventos recebe.
- Eventos selecionáveis:
  - vencimentos (D-N configurável, D-0, atrasados), com PIX/linha digitável para copiar;
  - resumo diário/semanal (vencimentos, saldos por caixa, entradas e saídas);
  - fatura fechada (valor por pagadora), limite acima de X%, divergência de conciliação;
  - agente concluiu tarefa e mensagens enviadas pelo agente;
  - contratos: aviso prévio, fim da vigência, renovação pendente e data-base de reajuste ([020](020-contratos.md)).
- Destinos podem ser pessoais (do usuário) ou de uma caixa (ex.: grupo da casa).
- O canal é abstrato (email/WhatsApp no futuro). Envio por fila no worker, com retry e histórico.
- Na F15 ([029](029-fluxos-autonomos.md)), o destino também **recebe** mensagens: "Receber mensagens" liga o webhook do bot e um agente responde nos chats privados pareados (seção *Entrada*, abaixo).

## Decisões (F3)

### Destinos e permissões
- Tela `/messages`: destinos, eventos de cada um (gaveta) e o histórico de envios.
- Dono: **pessoal** (só o usuário o vê e gerencia), **de uma caixa** (vê quem lê a caixa, gerencia quem escreve nela) ou **global** (só o admin). O admin vê e gerencia todos.
- O **bot token é write-only**, como a senha: a API nunca o devolve (só `bot_id`, a parte pública), não entra em logs, auditoria, exportações nem tools de agente (exceto o JSON completo do backup do admin, [019](019-backup-e-restauracao.md)); na edição o campo vem vazio e vazio mantém o atual. O worker lê o token só da mensagem que reservou (`message_destination_token`).
- Destino com histórico não é excluído: é **arquivado** (e desativado). Desativar cancela as mensagens pendentes. "Restaurar" volta o destino desativado.
- **Enviar teste** enfileira uma mensagem `test` e já tenta entregá-la na hora, mostrando o resultado; falha temporária fica para o worker.

### Eventos (assinaturas)
- Um por evento por destino, com parâmetros validados (os mesmos do banco) e filtro de caixas (sem caixas = todas as que o dono vê; os cartões das pagadoras filtradas entram).
- Horários em America/Sao_Paulo. Se o worker estava parado no horário, envia ao voltar, no mesmo dia. Cada mensagem tem `dedup_key` (única por destino): rodar de novo nunca duplica.
  - **Vencimentos** (`due_reminder`, padrão D-3, D-1, D-0 às 08:00): uma mensagem por título em aberto (a pagar e a receber; num par espelhado com as duas caixas no escopo, só o lado a pagar), com a linha digitável e o PIX copia-e-cola em `<code>` (toque para copiar). Chave `due_reminder:<título>:D-<n>:<vencimento>`. Até 30 títulos por passada (o resto na seguinte).
  - **Atrasados** (`overdue`): uma vez por título, ou a cada N dias a partir do primeiro dia de atraso.
  - **Resumo diário**: vencimentos do dia, total atrasado, saldos por caixa e entradas e saídas de ontem. **Semanal** (no dia escolhido): vencimentos dos próximos 7 dias e entradas e saídas dos últimos 7.
  - **Fatura fechada**: valor por pagadora; só faturas fechadas depois de criar a assinatura e nos últimos 3 dias.
  - **Limite do cartão**: uma vez por mês por percentual atingido (o maior atingido).
  - **Divergência de conciliação**: extrato com saldo do banco ≠ saldo do app acima do mínimo, depois de 1 dia do import (tempo de conciliar) e até 8 dias.
  - **Agente** (`agent_completed`, `agent_message`): ponto de extensão pronto (`emitAgentEvent`) para a F4; vai aos destinos pessoais do usuário do agente e aos de caixa que ele lê.
  - **Aprovação pendente** (`ai_awaiting_approval`, F15, [029](029-fluxos-autonomos.md)): sem parâmetros; quando uma tarefa agendada ou a conciliação com IA para esperando aprovação. Vai aos destinos pessoais do usuário da execução e, na conciliação (que tem caixa), aos de caixa que veem a caixa do lote; a tarefa (sem caixa) não vai a destino de caixa. Chave `ai_awaiting_approval:run:<execução>:awaiting:<última confirmação pendente>:<assinatura>`.
  - **Orçamento de IA** (`ai_budget_alert`, F14, [028](028-limites-e-uso.md)): sem parâmetros. O destino global recebe todos os orçamentos; o pessoal de um admin, todos; o pessoal de outro usuário, só o orçamento `user` dele; o de caixa, nenhum. Chave `ai_budget_alert:<orçamento>:<AAAA-MM>:<limiar>` (o percentual de aviso ou 100).
  - **Contratos** (F5, [020](020-contratos.md)): `contract_notice_deadline` e `contract_ending` com `days_before` (0–180, padrão 15/7/1/0 e 30/7/0) e `send_at`; `contract_renewal_pending` com `send_at` e `repeat_every_days` opcional (padrão 7); `contract_readjustment` com `send_at`. Chaves `contract_notice_deadline:<ciclo>:D-<n>`, `contract_ending:<ciclo>:D-<n>`, `contract_renewal_pending:<tarefa>:<dia>` e `contract_readjustment:<contrato>:<data>`. Os avisos de vencimento e atraso mostram o contrato e a parcela (n/N).
- Corpo em HTML do Telegram (`parse_mode: HTML`), com escape de tudo o que vem do usuário, limite de 4096 caracteres (corta linhas inteiras) e link para o console quando `APP_URL` está definido.

### Fila e envio (worker)
- Laço próprio a cada `MESSAGE_INTERVAL_MS` (padrão 30 s): produz os eventos, cria as notificações do sino e consome a outbox.
- Consumo: `message_outbox_claim` (SKIP LOCKED) numa transação curta; envio pela Bot API `sendMessage` fora de transação; `mark_sent` ou `mark_failed` com `retry_after` do 429, backoff exponencial (30 s × 2^n, até 1 h, 5 tentativas) e falha permanente em 400/401/403/404. A URL base vem de `TELEGRAM_API_BASE` (testes e e2e usam uma Bot API falsa).
- Falha definitiva gera a notificação `message_failed` para o dono (ou quem criou o destino). O histórico mostra status, tentativas e erro, com **reenviar** (falhas) e **cancelar** (pendentes e falhas).

### Entrada (F15, [029](029-fluxos-autonomos.md))
- **Receber mensagens**: na edição do destino, o interruptor e o agente que responde. Ligar grava `inbound_enabled`, o agente e o SHA-256 de um segredo novo (`webhook_secret_hash`) e chama `setWebhook` (URL `<URL pública>/api/telegram/webhook/<destino>`, `secret_token`, só `message` e `callback_query`, descartando as pendentes) **na mesma transação**: o Telegram recusou, nada muda (422 com o motivo). Exige a URL pública HTTPS (`app_settings` `telegram.public_base_url`, gravada em /admin/ai → Tarefas e Telegram, vence `PUBLIC_BASE_URL`); sem ela, o interruptor fica desabilitado com a explicação. Um bot aceita um webhook só (outro destino do mesmo bot com a entrada ligada dá 409).
- Desligar, desativar ou arquivar o destino desliga a entrada **no mesmo UPDATE** e chama `deleteWebhook` depois (o token é lido antes). Trocar o token com a entrada ligada religa o webhook no bot novo e o desliga no antigo. A importação do backup traz o destino com a entrada desligada.
- O token do bot, nesses casos e nas respostas aos chats, é lido por `telegram_inbound_bot_token(destino)` (só destino ativo, não arquivado e com a entrada ligada ou já ligada antes; [016](016-banco-de-dados.md)); nunca sai da integração. As respostas aos chats privados vão direto pela Bot API, fora da outbox (o histórico do destino, visível a quem gerencia um destino de caixa, não mostra conversas privadas de outros usuários).
- O que o webhook faz (autenticação, dedup, pareamento, conversa, mídia, botões e comandos) está na [029](029-fluxos-autonomos.md).

### Notificações do sino
- O sino lê `notifications` do usuário (não lidas primeiro, marcar lida ao abrir, "marcar todas"). O worker cria, com dedup: espelho aguardando aceite (editores da caixa do espelho), espelho contestado (editores da caixa do original), fatura fechada, limite do cartão (80% e 100%, uma vez por mês), divergência de conciliação, mensagem não enviada, orçamento de IA no aviso e a 100% (o usuário do orçamento `user` e todos os admins; [028](028-limites-e-uso.md)), a aprovação pendente de uma tarefa agendada ou da conciliação com IA (`ai_awaiting_approval`, o usuário da execução; [029](029-fluxos-autonomos.md)) e, no horário `NOTIFY_AT` (padrão 08:00), "vence hoje" e "atrasados" por caixa. Destinatários: membros da caixa e os admins.
