---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Leitura (e o notify_user) em ask mostra cartão vazio, e leituras com efeito externo vão ao /mcp como inofensivas

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** prévia ausente nas leituras / anotações MCP
- **Arquivos afetados:** `apps/server/src/agents/tools-runtime.ts:330-334`, `apps/server/src/agents/tool-handlers.ts:276-348,947-961`, `apps/server/src/agents/tool-handlers-operation.ts:696-710`, `apps/server/src/agents/tool-handlers-admin.ts:708-709`, `apps/web/src/agents/ConversationPane.tsx:514-520,577-578`, `apps/server/src/routes/mcp.ts:51-57`, `AGENTS.md:94`, `docs/021-kit-de-ferramentas.md:8,86`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O kit pode exigir aprovação também para consultas (por exemplo, "Ler documento", que custa IA, ou "Consultar CNPJ"). Nesse caso o cartão mostra só o nome da ação, sem dizer o que vai ser consultado. Quem aprova não sabe o que está aprovando. O mesmo vale para "Avisar o usuário", que aparece sem o texto do aviso.

### Evidência e análise técnica
- `RunTools.preview` (`tools-runtime.ts:330-334`): sem `handler.preview`, devolve `{ title, summary: '', action: 'other', rows: [] }`. `PreviewRows` não desenha nada com `rows` vazio (`ConversationPane.tsx:577-578`), e como `preview` existe, nem o "Sem prévia para esta ação." aparece (`:520`). O cartão fica com o selo "other" e o título.
- Conferido com um script sobre o registro e os arquivos de handlers: das 59 leituras, nenhuma tem `preview`; das 123 escritas, só `notify_user` não tem (`tool-handlers.ts:947-961`).
- `AGENTS.md:94` pede "`preview` nas escritas (e nas leituras, que também podem ficar em `ask` num kit)"; `docs/021:8` diz que o kit decide para leituras e escritas e `docs/021:86` testa "em `ask`, a leitura pede confirmação". O cartão dessa confirmação é vazio.
- Leituras com custo ou efeito externo, que são as que mais fazem sentido em `ask`: `read_document` (chama o agente dos fluxos e gasta orçamento, `tool-handlers-operation.ts:696-701`), `lookup_cnpj` (CNPJ Aberto/BrasilAPI, `tool-handlers.ts:342`), `semantic_search` (embeddings), `test_provider` e `list_provider_models` (chamam o provedor, `tool-handlers-admin.ts:708-709`), `simulate_import`.
- No `/mcp` (`routes/mcp.ts:51-57`), essas leituras saem com `readOnlyHint: true`, `idempotentHint: true` e `openWorldHint: false`; só `send_telegram_message` e `notify_user` têm `openWorldHint: true`. Pela especificação do MCP, `openWorldHint` diz se a tool fala com entidades externas: as acima falam (IA paga, Receita, provedor), e `send_test_message`, `refresh_mcp_tools` e `convert_contract_pdf` também.

### Verificação (tentativa de refutação)
- A entrada da chamada fica em `ai_tool_confirmations.input`, mas o cartão não a mostra (só `preview`).
- As tools de MCP externas já têm uma prévia genérica com a entrada linha a linha (`tools-runtime.ts:318-329`); as internas sem `preview` não usam esse recurso.

### Impacto
Aprovação sem informação nas leituras em `ask` e no `notify_user` em `ask`. Clientes do `/mcp` podem rodar sem perguntar leituras que gastam IA ou cota externa.

## Como reproduzir
Kit com `read_document` em `ask`; anexar um PDF e pedir "leia este boleto". O cartão mostra "Ler documento" sem o arquivo.

## Solução proposta
- Em `RunTools.preview`, sem `handler.preview`, usar a mesma prévia genérica das tools MCP: uma linha por campo da entrada (com os ids trocados por nomes quando for simples, via `withNames`), `action` `other` para leitura.
- Prévia própria (curta) em `notify_user` (título e texto) e em `read_document` (arquivo e o aviso de custo).
- No `/mcp`, `openWorldHint: true` para as tools que chamam serviços externos (uma marca `external` no registro, em vez da lista fixa de nomes).

## Critérios de aceite
- [ ] Toda tool interna em `ask` mostra pelo menos os argumentos no cartão.
- [ ] `notify_user` em `ask` mostra título e texto.
- [ ] As tools com chamada externa saem no `/mcp` com `openWorldHint: true`.

## Testes recomendados
`apps/server/test/agents.test.ts` (ou `agent-tools.test.ts`): kit com `list_titles` em `ask` → a confirmação tem `preview.rows` com os filtros; `notify_user` em `ask` → título e texto. `packages/shared/test/agents.test.ts`: as tools marcadas `external` ganham `openWorldHint` (se a marca for para o registro).

## Limitações e suposições
A contagem de prévias foi feita por expressão regular sobre os arquivos de handlers (todas as tools do registro foram encontradas).

## Análise (triagem)

## Resolução (executor)
