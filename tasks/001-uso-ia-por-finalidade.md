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

# Separar o uso de IA da leitura de documento e da classificação

## Descrição
`ai_usage.purpose` só aceita `chat|title|embedding`. A leitura de documento (`/api/title-entry/document`) e as sugestões da conciliação rodam como execuções de agente e são registradas como `chat`, então o painel de uso não separa esses custos. Pedido: aceitar `document` e `classification` em `ai_usage.purpose`. Depois, o `app` passa a gravar a finalidade certa.

## Como reproduzir
Usar a leitura de documento com um agente ativo e ver em `ai_usage` a linha com `purpose = 'chat'`.

## Análise (triagem)

## Resolução (executor)
