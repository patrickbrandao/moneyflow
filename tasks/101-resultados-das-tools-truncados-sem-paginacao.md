---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 5d66b57
---

# Resultados das tools cortados no meio do JSON em 60 mil caracteres, em listas sem paginação (inclusive o extrato sem período)

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** resultado de tool sem limite de tamanho / paginação
- **Arquivos afetados:** `apps/server/src/agents/tools-runtime.ts:75,154-158`, `apps/server/src/agents/tool-handlers.ts:281`, `apps/server/src/routes/mcp.ts:65,79`, `packages/shared/src/agents/tools.ts:127-134,173-189,198-205,222-229`, `packages/shared/src/agents/tools-operation.ts:64-81`, `packages/shared/src/agents/tools-admin.ts:251-264,267-276,453-460,491-503,553-561`, `packages/shared/src/schemas/index.ts:285`, `apps/server/src/services/titles.ts:130-135`, `apps/server/src/services/statement.ts:21-61`, `apps/server/src/services/audit.ts:104-108`, `apps/server/src/services/ai-admin.ts:502-507,539-542,943-949`, `docs/011-agentes-de-ia.md:77`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o agente pede uma lista grande (títulos, extrato de uma conta, catálogo de ferramentas, agentes), a resposta é cortada no meio sem aviso útil. O agente vê só a primeira parte e responde como se tivesse visto tudo: "não há contas vencendo em dezembro", quando elas estavam depois do corte. No extrato de uma conta pedido sem datas, o corte cai justamente nos movimentos recentes: o agente responde sobre o mês passado com dados de meses atrás.

### Evidência e análise técnica
- `resultText` (`tools-runtime.ts:154-158`) faz `JSON.stringify` e corta em `MAX_RESULT_CHARS = 60_000` com `text.slice(0, 60000)` mais `… [resultado truncado: N caracteres]`. O corte cai no meio de um objeto: o JSON fica inválido e o modelo não sabe quantos itens perdeu nem como pedir o resto. O `/mcp` usa o mesmo `resultText` (`routes/mcp.ts:65,79`).
- `docs/011:77` promete que "as leituras que podem passar disso (os lotes de extrato e as linhas de um lote) são paginadas". Outras leituras passam disso sem paginação:
  - `list_titles` (`tools.ts:173-189`): `limit` até 300, sem `offset`/cursor nem total. Uma linha de `TitleRow` (`titles.ts:46-61`, cerca de 40 campos, 8 uuids) tem cerca de 1.100 caracteres em JSON: cabem uns 52 títulos em 60 mil, então qualquer `limit` acima de ~55 é cortado. A ordem é `due_date` crescente (`titles.ts:133`): sem `from`, o que sobra são os mais antigos.
  - `get_account_statement` (`tools.ts:127-134`, `tool-handlers.ts:281`, `statement.ts:34-52`): `statementQuery` tem `from` e `to` opcionais e nenhum limite (`schemas/index.ts:285`); sem período devolve o histórico inteiro, ordenado por data crescente. Com cerca de 300 caracteres por linha, sobram umas 130 a 200 linhas: as mais antigas, e os recentes ficam de fora. O `closingCents` vem antes de `rows` e sobrevive, então o saldo final aparece sem os movimentos que o explicam. Na tela o filtro sempre manda período (padrão 60 dias atrás e 30 à frente, spec 004), então o problema é a API sem período e a tool.
  - `list_agent_tools` sem filtro (`tools-admin.ts:491-503`): medido com o registro atual (script descartável sobre `AGENT_TOOLS`, os mesmos campos de `listToolCatalog`), o JSON tem 66.929 caracteres. Perdem-se as 16 últimas tools do registro: todas as de anotações, as três do provisório e quatro das receitas. Pedir "monte um kit com as de anotações" sem filtrar por categoria não as encontra.
  - `list_ai_agents` (`ai-admin.ts:502-507,539-542`) devolve o `systemPrompt` inteiro de cada agente (até 200 mil caracteres cada); `list_mcp_servers` (`ai-admin.ts:943-949`) devolve o cache de tools com os schemas e as instructions (até 50 mil).
  - `list_contracts` (`limit` até 500), `list_users` (500), `list_card_purchases` e `list_transfers` (300), `get_audit_history` (`audit.ts:104-108`, até 500 entradas com antes/depois).
- Só `get_statement_import` foi desenhado para caber (`compactLine` em `tool-handlers.ts:109-112`, "para caber mais linhas por página").

### Verificação (tentativa de refutação)
- O próprio teste admite o corte: `apps/server/test/agent-tools-admin.test.ts:119` ("o banco de teste compartilhado pode passar do limite e vir truncado: aí, o texto").
- O teste de kits usa `list_agent_tools` com `{ kind: 'read' }` (`agent-tools-admin.test.ts:524`), que cabe; sem filtro não há teste. Nenhum teste chama `get_account_statement` sem período.
- O `limit` padrão de `list_titles` (50) fica no limite do corte; os máximos dos schemas não foram calculados contra `MAX_RESULT_CHARS`.
- A marca `[resultado truncado]` existe, mas não diz itens nem como continuar, e a maioria dessas tools não tem como continuar. O modelo tende a usar o que recebeu.

### Impacto
Respostas erradas do agente sobre dados financeiros (o que vence, o que entrou na conta, os movimentos recentes), sem o usuário perceber. Também consome tokens com dados que ele não pediu e faz uma consulta inteira da conta a cada chamada de extrato. Afeta conversas, tarefas agendadas e clientes do `/mcp`. Cresce com o volume de dados de cada instalação.

## Como reproduzir
1. Caixa com 200 títulos em aberto. Pedir ao agente "liste os títulos em aberto" com `list_titles` e `limit: 300`: o resultado termina em `… [resultado truncado: ~220000 caracteres]` no meio de um título.
2. Admin: `list_agent_tools` com `{}`: `list_notes` e as demais de anotações não aparecem.
3. Conta com alguns meses ou 2 anos de extrato importado (algumas centenas de movimentos): `get_account_statement` sem datas devolve só os primeiros meses. Na conversa, "quais foram as saídas da conta X esta semana?": o agente chama `get_account_statement` sem período e o resultado truncado só traz os meses antigos.

## Solução proposta
- Truncar por item, não por caractere: um `fitResult` em `tools-runtime.ts` que, para resultado em lista (ou objeto com uma lista conhecida: `rows`, `items`, `lines`), corta itens inteiros até caber e acrescenta `{ truncated: true, shown, total, hint }` com a instrução de filtrar ou paginar. O JSON continua válido.
- Paginação nas listas grandes, como já é em `list_statement_imports`: `offset` (ou cursor) e `total`/`nextOffset` em `list_titles`, `list_card_purchases`, `list_transfers`, `list_contracts`, `get_audit_history`.
- `get_account_statement`: sem `from`, usar o padrão da tela (60 dias atrás até 30 à frente), dizer isso na descrição e devolver as linhas da mais recente para a mais antiga (ou só as últimas N) com `truncated: true` e o total (ou exigir período). Na API, pôr um teto no período (como `accountSummaryQuery`, 1100 dias) ou um `limit` com cursor.
- Baixar os máximos de `limit` para o que cabe (ou compactar as linhas como `compactLine`: sem nulos, sem cor, sem nomes repetidos).
- `list_ai_agents` sem o prompt inteiro (só o começo e o tamanho; o prompt por uma leitura de um agente) e `list_mcp_servers` sem os schemas das tools.
- Atualizar `docs/011:77` com a regra (toda leitura cabe no limite ou pagina).

## Critérios de aceite
- [ ] Nenhum resultado de tool chega ao modelo como JSON inválido; o corte diz quantos itens ficaram de fora e como continuar.
- [ ] `list_titles`, `get_account_statement`, `list_card_purchases`, `list_transfers`, `list_contracts` e `get_audit_history` paginam.
- [ ] `list_agent_tools` sem filtro traz o catálogo inteiro.
- [ ] `get_account_statement` sem período devolve o padrão de 90 dias, avisado no resultado.
- [ ] Com mais linhas que o limite, os movimentos mais recentes estão no resultado do extrato.

## Testes recomendados
- `packages/shared/test/agents.test.ts`: o catálogo de `list_agent_tools` (mesmos campos de `listToolCatalog`) cabe em `MAX_RESULT_CHARS` (exportar a constante).
- `apps/server/test/agent-tools.test.ts`: 120 títulos e `list_titles` com `limit` máximo → JSON válido, `truncated`/`nextOffset` corretos; a segunda página traz o resto. Conta com movimentos de vários meses: `get_account_statement` sem período traz só a janela padrão e o movimento de ontem.
- Unitário do `fitResult`: lista, objeto com `rows`, string longa.

## Limitações e suposições
O tamanho de uma linha de título foi estimado com um objeto montado com os campos de `rowSelect` (cerca de 1.100 caracteres); o do catálogo foi medido com `tsx` sobre o registro; o tamanho médio da linha do extrato foi estimado pelas colunas do SELECT. Nada foi executado contra o banco.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `resultText` cortava o JSON no meio em 60 mil caracteres; `list_titles`, `list_transfers`, `list_card_purchases`, `list_contracts` e `get_audit_history` não paginavam; `get_account_statement` sem período trazia o histórico inteiro em ordem crescente; `list_agent_tools` sem filtro passava do limite e `list_ai_agents`/`list_mcp_servers` levavam prompts e schemas inteiros.

## Resolução (executor)

- `packages/shared/src/agents/result.ts`: `MAX_RESULT_CHARS` e `fitResult`, que corta a lista (ou a maior lista do objeto) por item inteiro com `truncated: { field, shown, total, omitted, hint }`, corta o texto solto com a contagem e nunca devolve JSON inválido; `resultText` (runtime e `/mcp`) passa a usá-lo.
- Paginação `offset`/`limit` com `{ items, offset, nextOffset }` (`listPage` em `tool-helpers.ts`; o serviço busca `limit + 1`): `list_titles` (máximo 100, sem os campos nulos), `list_transfers` e `list_card_purchases` (100), `list_contracts` (200) e `get_audit_history` (100). Os serviços ganharam o `offset` (`titles.ts`, `transfers.ts`, `cards.ts`, `contracts.ts`, `audit.ts`) e a ordem com o id no fim, para a página ser estável.
- `get_account_statement`: sem `from`/`to`, a janela da tela (60 dias atrás a 30 à frente), avisada em `notes`; `limit` (padrão 150, até 300) que mantém os mais recentes, com `rowCount` e a nota dos mais antigos omitidos.
- `list_ai_agents` sem o prompt inteiro (`systemPromptStart` e `systemPromptLength`; com `agentId`, o agente inteiro); `list_mcp_servers` com os nomes das tools e o começo das instructions (com `serverId`, o servidor inteiro); `list_agent_tools` sem as descrições e sem os falsos, e o catálogo inteiro cabe.
- Decisão: a rota `GET /api/accounts/:id/statement` sem período ficou como está (a tela sempre manda o período, spec 004); o teto ficou na tool.
- Spec 011 atualizada (a regra dos resultados e das listas).
- Testes: `packages/shared/test/agents.test.ts` (`fitResult` com lista, objeto com `rows`, texto e item gigante; o catálogo cabe) e `apps/server/test/agent-tools.test.ts` (`list_titles` em três páginas sem repetir, `list_contracts` paginado, o extrato sem período e com `limit`).
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
