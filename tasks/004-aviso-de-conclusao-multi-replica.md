---
status: aberta
tipo: debito-tecnico
origem: agente
autor: app
responsavel:
prioridade: baixa
criada: 2026-10-11
commit:
---

# Aviso de conclusão do agente com várias réplicas da API

## Descrição
O aviso `agent_completed` é decidido pela presença no SSE dentro de cada processo da API (`events-hub.ts`). Com mais de uma réplica, cada uma só enxerga os próprios streams; o sino deduplica, mas a outbox do `emitAgentEvent` usa `Date.now()` na `dedup_key` e pode mandar o aviso duplicado no Telegram. Pedido: presença no banco ("visto até" por execução, ou heartbeat de presença) e `dedup_key` determinística por execução. Só é necessário quando houver mais de uma réplica; a triagem decide a prioridade.

## Como reproduzir
Subir duas réplicas da API, abrir a conversa numa e terminar a execução.

## Análise (triagem)

## Resolução (executor)
