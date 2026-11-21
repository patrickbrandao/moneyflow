---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Listas de títulos, compras, entidades e transferências cortadas em silêncio (300 linhas), com totais só do que veio

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** paginação ausente / total parcial
- **Arquivos afetados:** `apps/web/src/components/titles/TitlesTab.tsx:48-55,70-73,204-219`, `apps/web/src/components/card/PurchasesTab.tsx:43-53,173-184`, `apps/web/src/pages/EntitiesPage.tsx:40-46`, `apps/web/src/pages/TransfersPage.tsx:21`, `apps/web/src/components/caixa/PlannedOccurrences.tsx:31-34`, `packages/shared/src/schemas/index.ts:111,447,508`, `packages/shared/src/schemas/operation.ts:102`, `apps/server/src/services/titles.ts:133-134`, `apps/server/src/services/cards.ts:206`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A aba A pagar de uma caixa com muitos títulos mostra no máximo 300. O rodapé diz "300 títulos" e soma o valor e o aberto só desses 300, sem avisar que há mais. Os títulos com vencimento mais distante simplesmente não aparecem.

### Evidência e análise técnica
- `TitlesTab` pede `/api/titles?caixaId…&status…&from…&to…` sem `limit` (`:48-55`). O `titleListQuery` usa `default(300)`, com máximo de 1000 (`schemas/index.ts:447`). O servidor ordena por `due_date, created_at` e corta (`titles.ts:133-134`), então somem os **últimos** vencimentos do período. O rodapé (`:204-219`) mostra `data.length` e a soma de `amountCents`/`openCents` das linhas recebidas (`:70-73`), como se fosse o total do filtro.
- `PurchasesTab` faz o mesmo (`:49`, padrão 300 em `operation.ts:102`, ordem `purchased_on DESC` em `cards.ts:206`): somem as compras **mais antigas** do período, e o rodapé "N lançamentos · total" fica parcial (`:173-184`).
- `EntitiesPage` pede `limit=300` (`:40`). A aba "Todas" de um cadastro com 301 entidades corta por nome, sem aviso.
- `TransfersPage` usa o padrão de 300 (`:21`, `schemas/index.ts:508`), sem filtro de período, então com o tempo só as 300 mais recentes ficam acessíveis.
- `PlannedOccurrences` pede `limit=100` e ordena no cliente (`:31-34`): se houver mais de 100 em aberto, a ordem e o recorte divergem do que a tela promete ("as ocorrências em aberto").
- Em nenhuma dessas telas há "carregar mais", aviso de "mostrando os primeiros N" ou total vindo do servidor.

### Verificação (tentativa de refutação)
- O período padrão (60 dias para trás e 30 à frente, `docs/004:28`) reduz o risco, mas qualquer usuário pode limpar as datas ou escolher "Todos". Uma empresa com dezenas de títulos por dia passa de 300 em 90 dias.
- A spec 014 (`:45`) define o limite da **exportação** (500 títulos e entidades, 1000 compras), não o da tela. Nenhuma spec diz que a listagem pode cortar sem aviso.
- O extrato da conta (`statement.ts:21-60`) não tem limite e não sofre do problema.

### Impacto
O total "em aberto" de uma aba de títulos fica menor que o real, sem que ninguém perceba. Títulos ficam fora da vista quando passam do corte. A ordem invertida entre títulos e compras faz o pedaço que some ser diferente em cada tela.

## Como reproduzir
1. Crie uma série mensal de 400 ocorrências numa caixa de teste (ou um seed com mais de 300 títulos num período).
2. A pagar → filtro "Todos", datas vazias: o rodapé mostra 300 títulos e a soma deles. O `GET /api/titles` com `limit=1000` traz mais.

## Solução proposta
1. Servidor: devolver também o total e a soma do filtro (cabeçalho `X-Total-Count` e `X-Sum-*`, ou um envelope `{ rows, total, sums, nextCursor }` nas rotas de listagem), ou uma rota de totais.
2. Tela: rodapé com o total do servidor e, quando `rows.length < total`, o aviso "Mostrando N de M" com "Carregar mais" (cursor por `due_date,id` nos títulos e `purchased_on,id` nas compras).
3. Enquanto isso não existe, ao menos pedir `limit = máximo + 1` e mostrar o aviso quando vier mais do que o máximo.
4. Em `PlannedOccurrences`, ordenar no servidor (`ORDER BY due_date`) e avisar quando houver corte.

## Critérios de aceite
- [ ] Com mais títulos que o limite, a aba mostra o aviso e o rodapé traz o total real do filtro.
- [ ] "Carregar mais" completa a lista sem repetir nem pular linhas.
- [ ] O mesmo nas compras do cartão e em Entidades.

## Testes recomendados
- `apps/server/test/titles.test.ts`: o total e a soma devolvidos batem com o filtro quando há mais linhas que o `limit`.
- e2e: semear 305 títulos e conferir o aviso "Mostrando 300 de 305".

## Limitações e suposições
Nada foi executado. Não conferi se algum usuário de produção já passa de 300 num período. A conclusão vale pelo código.

## Análise (triagem)

## Resolução (executor)
