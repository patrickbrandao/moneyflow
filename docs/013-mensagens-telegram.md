# 013 — Mensagens (Telegram, só envio)

- **Cadastro central de destinos Telegram**: token do bot + chat_id (pessoa ou grupo), com vários bots/contas. Cada destino escolhe quais eventos recebe.
- Eventos selecionáveis:
  - vencimentos (D-N configurável, D-0, atrasados), com PIX/linha digitável para copiar;
  - resumo diário/semanal (vencimentos, saldos por caixa, entradas e saídas);
  - fatura fechada (valor por pagadora), limite acima de X%, divergência de conciliação;
  - agente concluiu tarefa e mensagens enviadas pelo agente.
- Destinos podem ser pessoais (do usuário) ou de uma caixa (ex.: grupo da casa).
- O canal é abstrato (email/WhatsApp no futuro). Envio por fila no worker, com retry e histórico.

## Decisões (F3)

### Destinos e permissões
- Tela `/messages`: destinos, eventos de cada um (gaveta) e o histórico de envios.
- Dono: **pessoal** (só o usuário o vê e gerencia), **de uma caixa** (vê quem lê a caixa, gerencia quem escreve nela) ou **global** (só o admin). O admin vê e gerencia todos.
- O **bot token é write-only**, como a senha: a API nunca o devolve (só `bot_id`, a parte pública), não entra em logs, auditoria, exportações nem tools de agente; na edição o campo vem vazio e vazio mantém o atual. O worker lê o token só da mensagem que reservou (`message_destination_token`).
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
- Corpo em HTML do Telegram (`parse_mode: HTML`), com escape de tudo o que vem do usuário, limite de 4096 caracteres (corta linhas inteiras) e link para o console quando `APP_URL` está definido.

### Fila e envio (worker)
- Laço próprio a cada `MESSAGE_INTERVAL_MS` (padrão 30 s): produz os eventos, cria as notificações do sino e consome a outbox.
- Consumo: `message_outbox_claim` (SKIP LOCKED) numa transação curta; envio pela Bot API `sendMessage` fora de transação; `mark_sent` ou `mark_failed` com `retry_after` do 429, backoff exponencial (30 s × 2^n, até 1 h, 5 tentativas) e falha permanente em 400/401/403/404. A URL base vem de `TELEGRAM_API_BASE` (testes e e2e usam uma Bot API falsa).
- Falha definitiva gera a notificação `message_failed` para o dono (ou quem criou o destino). O histórico mostra status, tentativas e erro, com **reenviar** (falhas) e **cancelar** (pendentes e falhas).

### Notificações do sino
- O sino lê `notifications` do usuário (não lidas primeiro, marcar lida ao abrir, "marcar todas"). O worker cria, com dedup: espelho aguardando aceite (editores da caixa do espelho), espelho contestado (editores da caixa do original), fatura fechada, limite do cartão (80% e 100%, uma vez por mês), divergência de conciliação, mensagem não enviada e, no horário `NOTIFY_AT` (padrão 08:00), "vence hoje" e "atrasados" por caixa. Destinatários: membros da caixa e os admins.
