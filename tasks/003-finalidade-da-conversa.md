---
status: aberta
tipo: banco
origem: agente
autor: app
responsavel:
prioridade: baixa
criada: 2026-10-11
commit:
---

# Coluna própria para a finalidade da conversa

## Descrição
As conversas criadas pelos fluxos (documento, classificação) são marcadas por `screen_context.purpose` (jsonb) e arquivadas para sumir da lista. Pedido: `ai_conversations.purpose` (`chat|document|classification`, padrão `chat`) com índice, para filtrar sem depender do jsonb; depois o `app` migra o uso.

## Como reproduzir
Consultar `ai_conversations` com `screen_context->>'purpose'`.

## Análise (triagem)

## Resolução (executor)
