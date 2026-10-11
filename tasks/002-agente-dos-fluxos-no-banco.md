---
status: aberta
tipo: banco
origem: agente
autor: app
responsavel:
prioridade: media
criada: 2026-10-11
commit:
---

# Marcar no banco qual agente atende os fluxos automáticos

## Descrição
Hoje o agente usado na leitura de documento e nas sugestões da conciliação vem da variável `AI_FLOW_AGENT` (pelo nome) ou é o primeiro agente ativo. Pedido: uma marca em `ai_agents` (ex.: `use_for_flows boolean`, no máximo um ativo) para o admin escolher pela tela; depois o `app` remove a variável e expõe a escolha em /admin/ai.

## Como reproduzir
Ver `apps/server` (resolução do agente dos fluxos) e o `.env.example`.

## Análise (triagem)

## Resolução (executor)
