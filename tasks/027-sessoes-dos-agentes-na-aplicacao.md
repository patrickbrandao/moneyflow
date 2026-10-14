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

# Fio por agente, finalizar sessão e sessões anteriores (F12)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [026](../docs/026-sessoes-dos-agentes.md), seção "Aplicação (app)". O que fazer: Rotas por agente (`threads`, `sessions`, `finish`), menu Agentes por agente, uma janela por agente, "Finalizar sessão", sessões anteriores em leitura com "Bifurcar daqui", conversão do `localStorage`, textos "sessão"; testes e e2e.

Ordem: Depois da 026. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [026](../docs/026-sessoes-dos-agentes.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **`services/conversations.ts`**:
  - listar e criar;
  - `sendMessage` (l. ~295);
  - `updateConversation` (fixar e arquivar);
  - `forkConversation` e `deleteConversation`.
- **`routes/agents.ts`**: as rotas novas por agente. As rotas por conversa continuam.
- **Shared**: `agents/schemas.ts` e `agents/types.ts`.
- **Web**:
  - `AgentsMenu.tsx`, `AgentWindows.tsx`, `AgentSidePanel.tsx`, `useConversation.ts` e `useConversationActions.tsx`;
  - `AgentsProvider.tsx`: a conversão do `localStorage` `moneyflow:agents-ui`;
  - textos em `agents-ui.ts`.
- **Backup**: `backup/import.ts` (veja a 026, ponto 2).
- **e2e existentes que mudam**: conversa, ancorar, minimizar, reconexão do SSE e o admin lendo outra conversa.
- **Banco**: `pnpm db:pull` depois da 026.

**Riscos e observações**
- É a maior reorganização do front dos agentes, e vários e2e dependem de "uma janela por conversa".
- **"Finalizar" com execução `running`**:
  - o `cancelRun` só cancela na hora quando a execução está na fila ou esperando confirmação;
  - rodando, o worker encerra na próxima batida (até 3 s);
  - até lá, arquivar é recusado (23514).

**Dependências**
- Depende da 026.
- A 033 (Telegram na sessão ativa e `/nova`) depende desta.

**Como verificar**
- Os testes da 026: segunda ativa, mensagem sem ativa, finalizar com execução, fork e só a sessão ativa indo ao modelo.
- O e2e de finalizar e bifurcar.

**Pontos para a revisão da spec**
1. (026, Finalizar sessão) "Se houver execução em andamento, ela é parada antes" não é imediato quando a execução está rodando. Recomendação: o banco aceita arquivar quando a execução já tem o cancelamento pedido (`ai_runs.cancel_requested_at`), ou a rota espera o cancelamento com um timeout curto e devolve 409 se ele não vier.

## Resolução (executor)
