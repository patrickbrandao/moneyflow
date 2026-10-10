# 013 — Mensagens (Telegram, só envio)

- **Cadastro central de destinos Telegram**: token do bot + chat_id (pessoa ou grupo), com vários bots/contas. Cada destino escolhe quais eventos recebe.
- Eventos selecionáveis:
  - vencimentos (D-N configurável, D-0, atrasados), com PIX/linha digitável para copiar;
  - resumo diário/semanal (vencimentos, saldos por caixa, entradas e saídas);
  - fatura fechada (valor por pagadora), limite acima de X%, divergência de conciliação;
  - agente concluiu tarefa e mensagens enviadas pelo agente.
- Destinos podem ser pessoais (do usuário) ou de uma caixa (ex.: grupo da casa).
- O canal é abstrato (email/WhatsApp no futuro). Envio por fila no worker, com retry e histórico.
