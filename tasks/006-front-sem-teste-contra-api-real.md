---
status: aberta
tipo: debito-tecnico
origem: agente
autor: app
responsavel:
prioridade: media
criada: 2026-10-11
commit:
---

# Cobrir no e2e os fluxos do agente ainda sem teste contra a API real

## Descrição
Fluxos do frontend dos agentes que não foram exercitados contra a API real: reconexão do SSE após queda (Last-Event-ID), Recusar com motivo, modo somente leitura do admin ao abrir conversa de outro usuário e a tela de sugestões da conciliação (aprovar/descartar em lote). Também não há teste com provedor de embeddings (o fake responde `/v1/embeddings`, mas nada o usa). Pedido: testes e2e/integração para esses casos e corrigir o que falhar.

## Como reproduzir
Ver `e2e/tests/agentes.spec.ts` e `apps/server/test/agents.test.ts`.

## Análise (triagem)

## Resolução (executor)
