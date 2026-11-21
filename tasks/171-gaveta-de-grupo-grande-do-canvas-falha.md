---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Gaveta de um grupo grande do canvas falha: os ids das entidades vão na query string

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** bug
- **Subcategoria:** limite de URL e de lista na gaveta do cluster
- **Arquivos afetados:** `apps/web/src/components/canvas/FlowDrawer.tsx:19-45`, `packages/shared/src/schemas/vision.ts:63-68`, `apps/web/src/components/canvas/graph.ts:152-176`, `apps/server/src/services/flow.ts:93-98`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
No canvas de fluxo, as entidades da mesma categoria viram um grupo. Ao clicar num grupo grande (centenas de clientes ou lojas), a gaveta lateral mostra erro em vez dos lançamentos.

### Evidência e análise técnica
- O agrupamento do canvas (`graph.ts:152-166`) não tem teto de membros: com mais de 12 entidades, todas as do mesmo grupo de categoria e do mesmo lado entram num cluster.
- A gaveta manda todos os ids na URL: `params.set('entityIds', node.data.entityIds.join(','))` (`FlowDrawer.tsx:20,33`). O `URLSearchParams` codifica a vírgula como `%2C`: 39 bytes por entidade.
- A API recusa mais de 500 ids: `z.array(id).max(500)` (`schemas/vision.ts:68`), com `400`.
- Antes disso, o Node limita a linha de requisição mais os cabeçalhos a 16 KiB (`maxHeaderSize`) e responde `431` a partir de ~400 entidades. Um proxy na frente pode cortar antes: o nginx, com `large_client_header_buffers 8k`, responde `414` a partir de ~200.

### Verificação (tentativa de refutação)
- Não há paginação nem divisão da lista no front, e a rota só aceita GET (`routes/vision.ts:33`).
- O teto de 500 do schema é certo (`400` acima disso). Os limites do Node e do proxy dependem da implantação: por isso "provável".
- O "Expandir grupo" continua funcionando. Só a gaveta do grupo falha.

### Impacto
Caixas de empresa com muitos clientes ou fornecedores na mesma categoria, ou um ano de compras de cartão com centenas de lojas: a gaveta do grupo, que é o caminho para ver os lançamentos dele, quebra.

## Como reproduzir
1. Um período com mais de 500 entidades recebedoras na mesma categoria-grupo (por exemplo, pagamentos a 520 fornecedores de "Insumos").
2. No `/flow`, clique no cluster: `GET /api/flow/lines?...&entityIds=<520 ids>` devolve `400` (ou `431` a partir de ~400).

## Solução proposta
1. Identificar o cluster pelo que o define, não pelos membros: `groupCategoryId` + `side` + período. A API resolve no banco as entidades com aquele grupo principal entre as linhas do período.
2. Ou aceitar `POST /api/flow/lines` com os ids no corpo JSON, com um teto maior (por exemplo, 5.000).
3. Em qualquer caso, a gaveta deve mostrar uma mensagem clara se o grupo passar do teto.

## Critérios de aceite
- [ ] A gaveta de um cluster com 1.000 entidades mostra os lançamentos.
- [ ] Nenhuma requisição do canvas passa de alguns KB de URL.

## Testes recomendados
- `apps/server/test/vision.test.ts`, no `describe('canvas de fluxo (spec 014)')`: linhas de um grupo com 600 entidades pela forma nova (corpo ou grupo).
- Unitário do front para `linesPath` com um cluster grande, conferindo o tamanho da URL.

## Limitações e suposições
Não executado. O limite de 16 KiB é o padrão do Node (`--max-http-header-size`). O do proxy de produção não foi visto.

## Análise (triagem)

## Resolução (executor)
