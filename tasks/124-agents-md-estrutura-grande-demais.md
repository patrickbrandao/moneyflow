---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: c5e748d
---

# `AGENTS.md` + `docs/INDEX.md` carregam ~67 mil caracteres em todo contexto de agente; a "Estrutura" é metade disso

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** DX
- **Subcategoria:** custo de contexto dos agentes e manutenção da documentação de estrutura
- **Arquivos afetados:** `CLAUDE.md:5`, `AGENTS.md:7`, `AGENTS.md:71-78`, `AGENTS.md:86`, `docs/INDEX.md:28-65`, `.claude/agents/app.md:10-11`, `.claude/agents/triage.md:12`
- **Depende de / relacionado a:** tarefa 185
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Toda vez que um agente de IA começa a trabalhar no projeto, ele recebe automaticamente um texto de instruções enorme — mais ou menos 20 mil tokens — antes de ler uma linha de código. Metade é uma descrição de arquivos escrita em parágrafos gigantes, que cresce a cada fase. Isso custa dinheiro em cada sessão, deixa menos espaço para o código e é difícil de manter correto.

### Evidência e análise técnica
- `CLAUDE.md:5` importa `@AGENTS.md`, e `AGENTS.md:7` importa `@docs/INDEX.md`. Os dois somam **66.826 caracteres** (`wc -m`: 44.416 + 22.410), carregados em toda sessão e em todo subagente (`app`, `dba`, `triage`, e cada um dos revisores paralelos desta revisão). Em português técnico isso é da ordem de 19–22 mil tokens por contexto.
- A seção "Estrutura" (`AGENTS.md:71-78`) tem **30.098 caracteres** em quatro itens de lista: o de `apps/server` é **uma linha de 16.736 caracteres** (`AGENTS.md:73`), o de `apps/web` tem 7.484 (`:74`), o de `e2e` 3.707 (`:77`) e o do shared 1.727 (`:75`).
- O texto é cronológico (Fase 2, Fase 3, F4, F15, F16…), não por pasta, e por isso se repete e se contradiz: na linha 73, `contracts.ts` aparece duas vezes com descrições diferentes ("Contratos (specs 020 e 034): `contracts.ts` (cadastro com as obrigações…)" e, adiante, "Contratos sobre séries (spec 034, F20): … `contracts.ts` (contrato com vigência…)"), assim como `contract-worker.ts` e `ai-flows.ts` (2×), `reconciliation.ts` (3×) e `statements.ts` (4×).
- `AGENTS.md` foi alterado em 38 commits; quase toda fase acrescenta frases ao mesmo parágrafo, o que gera conflito de merge e texto obsoleto (ex.: `AGENTS.md:86` ainda diz que "As tools dos agentes (F4) **reaproveitarão** os mesmos serviços", no futuro, com a F4 entregue há meses).
- `docs/INDEX.md` repete, na tabela, resumos longos das specs (a linha da 016 tem 3.222 caracteres, `docs/INDEX.md:46`) que o agente só precisa quando vai mexer naquela área.
- `database/AGENTS.md` + `database/CLAUDE.md` já mostram o padrão certo: instruções de uma pasta ficam nela e só entram no contexto quando o agente trabalha ali.

### Verificação (tentativa de refutação)
- Conferi se o tamanho é necessário para as "Regras da aplicação" (`AGENTS.md:80-98`): elas têm ~7 mil caracteres e devem continuar na raiz; o que pesa é a "Estrutura", que é mapa de arquivos e se obtém por `ls`/`grep` sob demanda.
- Os subagentes `app` e `triage` mandam ler `AGENTS.md` e `docs/INDEX.md` de novo (`.claude/agents/app.md:10-11`, `triage.md:12`), ou seja, o texto já importado é relido como arquivo.

### Impacto
Custo fixo de tokens em cada sessão e subagente (numa revisão com 13 revisores paralelos, ~260 mil tokens só de instruções), menos janela útil para o código e uma "Estrutura" que já tem duplicatas e frases vencidas, que um agente pode tomar como verdade.

## Como reproduzir
`wc -m AGENTS.md docs/INDEX.md`; `awk '{ if (length($0) > 1000) print NR": "length($0) }' AGENTS.md`; `sed -n 73p AGENTS.md | grep -o '`contracts.ts`' | wc -l` → 2.

## Solução proposta
1. Mover a "Estrutura" para arquivos por pasta, carregados só quando o agente trabalha nelas, no mesmo padrão de `database/`: `apps/server/AGENTS.md` (+ `apps/server/CLAUDE.md` com `@AGENTS.md`), `apps/web/AGENTS.md`, `packages/shared/AGENTS.md`, `e2e/AGENTS.md`.
2. Em cada um, organizar por **pasta e arquivo**, não por fase: uma linha por arquivo (`services/series.ts` — a série como obrigação: `insertObligation`, `planSeriesChange`…; testes: `test/contracts.test.ts`). Isso também alimenta o mapa de testes proposto em tarefa 127.
3. Na raiz, deixar um mapa de 10 linhas ("`apps/server`: API e worker, ver `apps/server/AGENTS.md`") e as "Regras da aplicação" (que são transversais).
4. Trocar `@docs/INDEX.md` por um link simples ("leia `docs/INDEX.md` antes de mexer numa área") e encurtar as linhas da tabela para uma frase; o detalhe fica no cabeçalho de cada spec.
5. Tirar a releitura de `AGENTS.md`/`docs/INDEX.md` das instruções dos subagentes (já vêm no contexto) ou mantê-la só para o arquivo da pasta.

## Critérios de aceite
- [ ] `AGENTS.md` da raiz abaixo de ~15 mil caracteres, sem linha acima de 1.000.
- [ ] Nenhum arquivo citado duas vezes com descrições diferentes.
- [ ] Cada pacote com o seu `AGENTS.md` por arquivo, com o teste correspondente.
- [ ] `docs/INDEX.md` não é mais importado automaticamente.

## Testes recomendados
Não há teste de código. Conferir numa sessão nova que o contexto inicial caiu (`/context` no Claude Code) e que um agente, trabalhando em `apps/server`, recebe o `apps/server/AGENTS.md`.

## Limitações e suposições
A contagem de tokens é estimativa por caracteres; não medi com o tokenizador. Assumo o comportamento do Claude Code de carregar `CLAUDE.md` de subpastas sob demanda (já usado em `database/`); o Codex lê `AGENTS.md` da raiz até a pasta de trabalho, então a divisão também funciona para ele.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código atual da integração (`fe8786d`): o `CLAUDE.md` importa o `AGENTS.md`, que importa o `docs/INDEX.md`; juntos carregavam 71.308 caracteres em todo contexto (`CLAUDE.md` 128 + `AGENTS.md` 46.858 + `INDEX.md` 24.322), mais que na revisão, porque as correções desta rodada acrescentaram frases. A "Estrutura" seguia cronológica, com a linha do `apps/server` em 16.894 caracteres e arquivos repetidos com descrições diferentes (`contracts.ts`, `ai-flows.ts`, `reconciliation.ts`, `statements.ts`).

## Resolução (executor)

Medida (`wc -m`), o que entra em todo contexto:

| | Antes | Depois |
|---|---|---|
| `CLAUDE.md` | 128 | 128 |
| `AGENTS.md` | 46.858 | 15.423 |
| `docs/INDEX.md` (importado) | 24.322 | 0 (vira link; o arquivo tem 8.712) |
| **Total** | **71.308** | **15.551** (−78%) |

Sob demanda, só quando o trabalho chega à pasta: `apps/server/AGENTS.md` 28.565, `apps/web/AGENTS.md` 12.808, `e2e/AGENTS.md` 6.656, `packages/shared/AGENTS.md` 5.928, `packages/db/AGENTS.md` 1.173.

- **`AGENTS.md` da raiz**: ficaram as seções transversais (especificações, banco, tarefas, verificação, comandos, regras da aplicação, configuração) e uma "Estrutura" de nove linhas que aponta para o `AGENTS.md` de cada pacote e manda lê-lo antes de mexer na pasta (o Codex lê só o da raiz quando roda na raiz). Nenhuma regra foi cortada: as duas linhas longas (a da verificação rápida e a dos agentes, 1.680) viraram sub-itens; nenhuma linha passa de 1.000 caracteres. Saíram para o pacote só os detalhes: os falsos e as portas dos e2e (para `e2e/AGENTS.md`) e o modo local dos testes em detalhe (para `apps/server/AGENTS.md`). Ficou em ~15,4 mil, um pouco acima da meta de ~15 mil, para não encurtar regra.
- **Um `AGENTS.md` por pacote**, no padrão de `database/` (com o `CLAUDE.md` da pasta só com `@AGENTS.md`): `apps/server`, `apps/web`, `packages/shared`, `packages/db` e `e2e`. Organizados por pasta e arquivo, não por fase; no server, cada arquivo com os testes de integração do `test/related.json`; no shared, com o teste unitário; na web e nos e2e, com o spec de `e2e/tests`. Arquivos de mesmo nome em pastas diferentes levam a pasta (`routes/contracts.ts`, `agents/worker.ts`, `integrations/telegram.ts`), e nenhum arquivo aparece duas vezes como item.
- **Sem perder informação**: um script comparou os 712 identificadores entre crases da "Estrutura" antiga com os arquivos novos; os 5 que não voltam iguais foram reescritos de propósito (a rota da conta agora com os nomes reais, `/caixas/:id/accounts/:accountId/:tab`). Os arquivos que a "Estrutura" não citava (por exemplo `overview.ts`, `title-pair.ts`, `settlements.ts`, `transfers.ts`, `reconciliation-guards.ts`, `backup/lock.ts`, `backup/unzip.ts`, `shutdown.ts`, `log.ts`, os specs `carga`, `sessao`, `respostas`, `teclado` e `cnpj-consulta`) entraram, conferidos no código.
- **`docs/INDEX.md`** deixou de ser importado (o `AGENTS.md` só o cita). A tabela ficou com uma frase por spec; o texto longo de cada linha foi para a linha **Conteúdo** do topo da própria spec (as 35), sem a marca "(entregue)", e a convenção nova está no INDEX. O estado das fases fica só na 015.
- **Subagentes** (item 5 da solução): não mexi nas listas de leitura do `app.md` e do `triage.md`, a pedido da sessão principal (só comandos que mudaram). Agora que o INDEX não é importado, a leitura dele que elas pedem passou a ser necessária; a releitura do `AGENTS.md` da raiz continua redundante.
- `docs/001-stack-e-entrega.md` (Repositório): onde ficam as instruções dos agentes.

Testes: não há teste de código para a reorganização. Conferido: todo link relativo e todo `@` dos 49 arquivos `.md` alterados ou novos aponta para um arquivo que existe (script, 459 links, 0 quebrados).

Verificação: rápida, `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_docs pnpm verify:quick --base fe8786d` (lint, typecheck de todos os pacotes, testes dos scripts e `test/config.test.ts`), e `pnpm lint`. Fica para conferir numa sessão nova: o `/context` inicial e o `apps/server/AGENTS.md` carregado ao abrir um arquivo do server.
