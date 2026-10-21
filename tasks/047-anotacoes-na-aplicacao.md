---
status: em-andamento
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-21
commit:
---

# Anotações e lembretes na aplicação (F21)

## Descrição
Todo o resto da spec [035](../docs/035-anotacoes.md): serviço e rotas (`Access` com a visibilidade privada/global/admin, edição só do autor e do admin, `withTx`), laço do worker que dispara os lembretes (log, sino `note_reminder`, Telegram opcional pelo destino pessoal do autor, adiar), tools dos agentes (categoria "Anotações", expostas no `/mcp`, prévia nas escritas, sem entrar em kit nenhum), backup, tela `/notes` (menu abaixo de Contratos, calendário anual e mensal com bolinhas, tabela com `DateRangeFilter` e filtros de tipo, entidade, escopo/autor e texto, janela com as guias Anotação, Lembrete e Escopo), aba Anotações e selo na entidade, Minha conta → Lembretes, ícone do alarme entre o tema e os agentes com o popover (dispensar, adiar, marcar todos como lidos), sons em `apps/web/public/sounds` com manifest, uma aba toca (`BroadcastChannel`) e o aviso de autoplay; testes de integração, das tools e e2e.

Ordem: depois da [046](046-anotacoes-no-banco.md).

## Como reproduzir
Não se aplica (recurso novo).

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-21).

**Executor designado: app.**

## Resolução (executor)
