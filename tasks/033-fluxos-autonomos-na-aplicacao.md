---
status: aberta
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
