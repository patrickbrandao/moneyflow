# 017 — Tarefas entre agentes (`tasks/`)

## O que é

`tasks/` guarda **tarefas de revisão e correção de código pedidas entre agentes**, e também os achados do usuário durante a validação. Cada tarefa é um arquivo markdown `tasks/nnn-titulo.md`: número de 3 dígitos com zeros à esquerda, título em kebab-case, em português. Uma tarefa nova recebe o próximo número livre.

Toda tarefa tem um agente designado para analisá-la e levá-la até o fim. Nenhuma tarefa fica sem responsável.

## Papéis

- **Autor**: quem abre a tarefa. Pode ser o usuário, a sessão principal ou qualquer subagente que encontrou algo fora do próprio escopo (ex.: o agente de aplicação precisa de uma mudança no banco).
- **Triagem** (subagente `triage`, `.claude/agents/triage.md`): lê a tarefa, reproduz o problema quando houver, classifica e designa o executor. Não corrige código.
- **Executor**: `dba` para tudo em `database/`; `app` (`.claude/agents/app.md`) para aplicação, frontend, Docker, CI e documentação. O executor corrige, testa, atualiza as specs afetadas e fecha a tarefa.

Se a tarefa depende de uma decisão de produto, a triagem ou o executor muda o status para `bloqueada` e registra a pergunta, com a opção recomendada; a sessão principal leva a pergunta ao usuário.

## Formato

```markdown
---
status: aberta            # aberta | em-analise | em-andamento | bloqueada | concluida | rejeitada
tipo: bug                 # bug | melhoria | banco | debito-tecnico
origem: usuario           # usuario | agente
autor: usuario            # usuario | principal | app | dba | triage
responsavel:              # preenchido pela triagem: dba | app
prioridade: media         # alta | media | baixa
criada: 2026-10-11
commit:                   # hash(es) que resolveram
---

# Título curto

## Descrição
O que acontece, onde, e o que era esperado.

## Como reproduzir
Passos, dados, tela/rota (quando houver).

## Análise (triagem)
Causa provável, arquivos e specs afetados, executor designado.

## Resolução (executor)
O que mudou, testes que cobrem, specs atualizadas.
```

## Ciclo de vida

1. O autor cria o arquivo com `status: aberta` e acrescenta a linha em `tasks/INDEX.md`.
2. A triagem muda para `em-analise`, preenche "Análise", `responsavel` e `tipo`, e passa para `em-andamento` ao entregar ao executor (ou `rejeitada`, com o motivo, quando não procede).
3. O executor corrige com testes, roda as verificações do `AGENTS.md`, preenche "Resolução" e `commit` e muda para `concluida`.
4. Tarefas concluídas e rejeitadas **continuam na pasta** como histórico. `tasks/INDEX.md` lista todas, com as abertas primeiro.

Uma tarefa resolve um assunto; achados diferentes viram tarefas diferentes. Tarefas que mexem no banco e na aplicação são feitas em sequência: primeiro o `dba`, depois o `app`.
