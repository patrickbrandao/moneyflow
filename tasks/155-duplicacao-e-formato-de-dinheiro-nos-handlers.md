---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Auxiliares das prévias duplicados entre os handlers: dinheiro em dois formatos e o filtro de zeros do settle_title que nunca casa

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** melhoria
- **Subcategoria:** duplicação / consistência das prévias
- **Arquivos afetados:** `apps/server/src/agents/tool-handlers.ts:106-118,481,490,563-577,685,742-755,798-825,908-937`, `apps/server/src/agents/tool-handlers-supersede.ts:28-29`, `apps/server/src/agents/tool-handlers-operation.ts:45-46`, `apps/server/src/agents/tool-handlers-admin.ts:76-95,141-143,169-173,217-233,264`, `apps/server/src/agents/tool-handlers-recipes.ts:16-23`, `apps/server/src/agents/tools-runtime.ts:96`, `apps/server/src/services/ai-admin.ts:544-548,817-821,951-955`
- **Depende de / relacionado a:** tarefa 100
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O cartão de aprovação mostra valores ora como "R$ 1.234,56", ora como "1234,56", às vezes no mesmo cartão; datas ora "03/11/2026", ora "2026-11-03". O cartão de baixa ainda mostra "Juros R$ 0,00", "Multa R$ 0,00" e "Desconto R$ 0,00" mesmo sem encargos, porque o código que deveria escondê-los compara com um texto que nunca aparece. Por trás, o mesmo pedaço de código está copiado em vários arquivos, e cada cópia evoluiu de um jeito.

### Evidência e análise técnica
- **Dinheiro**: `tool-handlers.ts` formata à mão, sem "R$" nem separador de milhar: `lineLabel` (`:106-107`), `brl` (`:114`), `create_title` (`:481,490`), `settle_title` "Em aberto" (`:563`), `create_card_purchase` (`:685`). No mesmo `settle_title`, "Valor", "Juros" e "Multa" passam por `diffRows` com `format: 'money'` → `formatBRL` ("R$ 1.234,56"). Os demais arquivos usam `formatBRL`.
- **Bug que nasce disso**: o filtro do `settle_title` que esconderia juros, multa e desconto zerados, `row.after !== 'R$ 0,00'` (`tool-handlers.ts:577`), compara com um espaço comum (0x20, conferido com `od -c`), mas `formatBRL` usa o espaço inseparável do `Intl` (U+00A0; `money.ts:2-6`). Rodado com `tsx`: `formatBRL(0) === 'R$ 0,00'` é `false`, e o filtro não tira nada. Todo cartão de baixa mostra "Juros R$ 0,00", "Multa R$ 0,00" e "Desconto R$ 0,00". Não há teste da prévia do `settle_title`.
- **Linha do extrato**: dois `lineLabel` com formatos diferentes — `tool-handlers.ts:106-107` (data ISO, valor sem R$) e `tool-handlers-supersede.ts:28-29` (`formatDate` e `formatBRL`).
- **Lote de linhas**: o mesmo laço (`for lineId of slice(0, PREVIEW_LINES)` + `lineCaixa` + `moreLines`) repete-se em `confirm_statement_lines`, `ignore_statement_lines`, `unignore_statement_lines` e `apply_classification_suggestions` (`:742-755,798-825,925-937`); `classify_statement_lines` usa `slice(0, 50)` fixo e, como `apply_classification_suggestions`, não avisa "E mais N linha(s)" (`:908-937`). `resolve_superseded_lines` lista as 500 linhas sem limite (`tool-handlers-supersede.ts:84-89`).
- **Pequenos auxiliares copiados**: `listed` (`tool-handlers-operation.ts:45-46` e `tool-handlers-admin.ts:93-94`), `yesNo` (`tool-handlers-admin.ts:95`, `tool-handlers-recipes.ts:16`), três leitores do nome do agente (`agentNameOf` em `tool-handlers-admin.ts:81-85`, `agentName` em `tool-handlers-recipes.ts:18-23` — que devolve o id em vez de 404 —, e `agentById` em `:169-173`, que carrega todos os agentes para achar um), `mcpById` (`:229-233`, carrega todos os servidores) e `memberOf` (`:141-143`, todos os membros). O serviço já tem `getAgent` e `getMcpServer` (`ai-admin.ts:544-548,951-955`), não exportados.
- **Validação do kit** duas vezes: `kitRows` (`tool-handlers-admin.ts:217-227`, contra `agentTool`) e `kitToolRows` (`ai-admin.ts:817-821`, contra `internalTool`).
- **Limite de anexo** repetido: `MAX_FILE_BYTES = 20 MB` em `tools-runtime.ts:96` e `tool-handlers-admin.ts:264`.

### Verificação (tentativa de refutação)
- Os testes de prévia trocam U+00A0 por espaço antes de comparar (`rowsOf`, `apps/server/test/agent-tools.test.ts:147-153`): é por isso que comparações como a do filtro passariam num teste e falham na execução.
- Não é estilo do Biome: são cópias de regra (formato do dinheiro, limite do lote, 404 do agente) que já divergiram.
- A regra da UI (`AGENTS.md`, valores "sempre pelo `Money` ou `formatAccounting`") vale para os componentes; o cartão desenha os textos que o servidor manda, então a consistência depende do handler.

### Impacto
Cartões inconsistentes para quem aprova (o "Em aberto" sem R$ ao lado do "Valor" com R$; datas em dois formatos), regras que derivam a cada tool nova e leituras desnecessárias (lista inteira de agentes ou servidores por prévia).

## Como reproduzir
`settle_title` em `ask` num título de R$ 1.234,56, sem juros nem multa: o cartão mostra "Em aberto 1234,56", "Valor R$ 1.234,56" e as linhas "Juros", "Multa" e "Desconto" com R$ 0,00.

## Solução proposta
Corte proposto, sem mudar comportamento além do formato:
0. No `settle_title`, filtrar os zeros pelo valor (`values.interestCents === 0`), não pelo texto formatado.
1. `tool-helpers.ts` ganha `money = formatBRL`, `listed`, `yesNo`, um único `lineLabel({ postedOn, description, amountCents })` com `formatDate`/`formatBRL`, e `linesPreview(ctx, title, lineIds)` (o laço com `lineCaixa`, `PREVIEW_LINES` e `moreLines`), usado pelas cinco tools de lote e pelo `resolve_superseded_lines`.
2. Exportar `getAgent`/`getMcpServer` de `ai-admin.ts` (com `assertAdmin` no chamador) e apagar `agentById`, `mcpById`, `agentName` e `agentNameOf`; `memberOf` vira uma consulta por `(caixa, usuário)` em `caixas.ts`.
3. `kitToolRows` exportado do serviço e usado pela prévia (uma validação só).
4. `ATTACHMENT_MAX_BYTES` no shared, usado pelo runtime, pelo backup e pelo `/mcp`.
5. Com isso, dividir `tool-handlers.ts` (963 linhas) em `tool-handlers-read.ts` (as leituras, `:276-348`) e `tool-handlers-reconciliation.ts` (conciliação, `:704-937`), ficando nele só cadastro, títulos, cartão e mensagens.

## Critérios de aceite
- [ ] A prévia do `settle_title` não mostra juros, multa e desconto zerados.
- [ ] Nenhuma prévia formata dinheiro fora de `formatBRL`, nem data de negócio fora de `formatDate`.
- [ ] As tools de lote usam o mesmo auxiliar e avisam as linhas não mostradas.
- [ ] Um único leitor de agente e de servidor MCP para as prévias.

## Testes recomendados
`apps/server/test/agent-tools.test.ts`: a prévia de `settle_title` sem encargos não tem as linhas "Juros", "Multa" e "Desconto", e traz "Em aberto" como "R$ …"; `classify_statement_lines` com 60 sugestões avisa "E mais 10 linha(s)". Os testes atuais de prévia que comparam o texto antigo precisam acompanhar.

## Limitações e suposições
Refatoração sem mudança de regra, salvo o filtro dos zeros; os testes de integração existentes cobrem o comportamento das tools. O resultado de `formatBRL(0)` foi conferido com `tsx` neste Node (v26); o `Intl` de qualquer Node com ICU completo usa U+00A0.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: dinheiro formatado à mão (sem R$) em várias prévias, o filtro de zeros do `settle_title` comparando com o espaço comum (nunca casava), dois `lineLabel`, o laço das prévias de lote copiado, `classify_statement_lines` e `apply_classification_suggestions` sem o aviso das linhas não mostradas, `resolve_superseded_lines` sem limite, `listed`/`yesNo` e os leitores de agente e de MCP repetidos, a validação do kit duas vezes e o limite de anexo repetido.

## Resolução (executor)

- `settle_title`: juros, multa e desconto zerados saem pelo valor, não pelo texto; "Em aberto" em R$.
- `tool-helpers.ts`: `listed`, `yesNo`, `agentSummary` (nome e kit do agente, 404 se não existe; usado pelas prévias de tarefas e receitas, que antes devolviam o id), um `lineLabel` só (dd/mm/aaaa e R$), `lineCaixa`, `PREVIEW_LINES`, `moreLines` e `linesPreview` (o laço das prévias de lote, que agora confere a escrita em todas as linhas e avisa as não mostradas), usado por confirmar, ignorar, voltar, classificar e aprovar; `resolve_superseded_lines` mostra até 50 e avisa o resto.
- Dinheiro e datas pelo `formatBRL`/`formatDate` em `tool-handlers.ts` (casamento, criação de título, compra, parcelas) e o tamanho do arquivo pelo `formatFileSize`.
- `ai-admin.ts` exporta `getAgent`, `getMcpServer` e `kitToolRows`: as prévias de agente e de MCP leem um registro (sem carregar a lista) e o kit usa a validação do serviço; o limite de anexo é o `MAX_ATTACHMENT_BYTES` de `services/attachments.ts`.
- Fora do escopo desta rodada (registrado aqui, sem tarefa nova): a divisão de `tool-handlers.ts` em leituras e conciliação e o `memberOf` por consulta única, para não abrir conflito com as outras frentes.
- Testes: `agent-tools.test.ts` (a prévia do `settle_title` sem encargos, só com Em aberto, Data, Valor e Conta em R$; `classify_statement_lines` com 60 sugestões mostra 50, avisa "E mais 10 linha(s)" e a linha formatada).
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
