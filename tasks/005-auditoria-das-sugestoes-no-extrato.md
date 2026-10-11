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

# Rastro de ator nas sugestões do agente em linhas de extrato

## Descrição
`statement_lines` está fora da auditoria, então as sugestões do agente (entidade/categoria) gravadas nas linhas de extrato não registram quem as fez. Pedido: avaliar `audit_row` em `statement_lines`, ignorando colunas de alto volume/ruído, para que `actor_kind = agent` e `agent_run_id` apareçam no log.

## Como reproduzir
Gerar sugestões com IA numa importação e procurar o registro no `audit_log`.

## Análise (triagem)

## Resolução (executor)
