---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: d4bf9d3
---

# Sino: as não lidas não vêm primeiro e as que passam das 30 mais recentes ficam inalcançáveis

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** ordenação e paginação da lista do sino
- **Arquivos afetados:** `apps/server/src/services/notifications.ts:15-31`, `apps/web/src/components/shell/Notifications.tsx:61-64,121-138`, `packages/shared/src/schemas/vision.ts:217-220`, `docs/013-mensagens-telegram.md:50`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O sino mostra as 30 notificações mais recentes, lidas ou não. Quem acumula avisos (vencimentos e atrasados de várias caixas todo dia, lembretes, agentes) vê o contador com, por exemplo, 45 não lidas, mas a lista só traz as últimas 30, várias já lidas. As não lidas mais antigas não aparecem nem dá para chegar até elas; só resta "marcar todas como lidas" sem ler.

### Evidência e análise técnica
- `listNotifications` ordena por `created_at DESC, id DESC LIMIT ${q.limit}` (`notifications.ts:18-21`), sem dar prioridade às não lidas e sem cursor.
- O console pede `{ limit: 30 }` sem `unread` (`Notifications.tsx:62`) e mostra a lista como veio (`:121-138`); não há "ver mais".
- A spec diz: "O sino lê `notifications` do usuário (não lidas primeiro, marcar lida ao abrir, "marcar todas")" (`docs/013:50`). O log dos lembretes, que é parecido, faz o que a spec pede: `ORDER BY (f.read_at IS NULL) DESC, f.last_fired_at DESC` (`notes.ts:443`).
- O volume diário é alto por desenho: "vence hoje" e "atrasados" por caixa para cada membro e para todos os admins (`message-worker.ts:707-751`), além de espelhos, faturas, limite, divergência, orçamentos, aprovações e lembretes. Um admin com dez caixas recebe até 20 por dia só desses dois.

### Verificação (tentativa de refutação)
- O `unread=true` existe na API, mas o console não o usa, e ele esconderia as lidas recentes.
- O índice `notifications_unread_idx (user_id, created_at DESC) WHERE read_at IS NULL` já atende a parte das não lidas; ordenar por `(read_at IS NULL) DESC` com o índice `(user_id, created_at DESC)` também é barato no volume de um usuário.
- Nenhum teste confere a ordem do sino.

### Impacto
O usuário perde avisos não lidos (um espelho aguardando aceite, uma aprovação pendente) atrás de avisos diários repetitivos. O efeito cresce com o número de caixas.

## Como reproduzir
1. Gere 40 notificações não lidas para um usuário e depois leia as 10 mais recentes.
2. Abra o sino: o contador diz 30, a lista mostra as 10 lidas e só 20 das 30 não lidas; as 10 não lidas mais antigas não aparecem.

## Solução proposta
1. `listNotifications`: `ORDER BY (read_at IS NULL) DESC, created_at DESC, id DESC`, como o log de lembretes, e um cursor (`before`, como em `outboxQuery`).
2. Console: "ver mais" no fim da lista do sino, usando o cursor.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/notifications.ts
+++ b/apps/server/src/services/notifications.ts
-       ORDER BY created_at DESC, id DESC LIMIT ${q.limit}`),
+       ORDER BY (read_at IS NULL) DESC, created_at DESC, id DESC LIMIT ${q.limit}`),
```

## Critérios de aceite
- [ ] Com mais não lidas que o limite, a lista do sino traz só não lidas, da mais nova para a mais antiga.
- [ ] Dá para chegar a todas as não lidas pela tela.

## Testes recomendados
`apps/server/test/vision.test.ts` (onde estão os testes do sino): 35 notificações, 5 lidas recentes; `GET /api/notifications?limit=30` devolve as 30 não lidas primeiro. E2E opcional no sino com "ver mais".

## Limitações e suposições
Nada foi executado. Não verifiquei se a especificação queria "não lidas primeiro" só visualmente (destaque); o texto diz "primeiro".

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `listNotifications` ordenava só por `created_at DESC, id DESC` com `LIMIT`, sem cursor, e o console pedia 30 sem "ver mais"; a spec 013 diz "não lidas primeiro".

## Resolução (executor)

- `apps/server/src/services/notifications.ts`: `ORDER BY (read_at IS NULL)::int DESC, created_at DESC, id DESC` e cursor por chave (`nextCursor`, base64url de não lida?/criação em microssegundos/id; `cursor` inválido = 400). Decisão: o cursor guarda a posição, não o id, para que ler uma notificação entre as páginas não pule as não lidas que faltam (a lida pode reaparecer entre as lidas; o console descarta o repetido).
- `packages/shared`: `notificationQuery.cursor`, `NotificationList.nextCursor`, os textos `loadMore` e `invalidCursor` (`i18n/areas/notifications.ts`) e a descrição da tool `list_notifications` ("as não lidas primeiro").
- `apps/web/src/components/shell/Notifications.tsx`: "Ver mais" no fim da lista (página de 30 pelo cursor, sem repetir) e a atualização de cada minuto relê o que já está carregado (até 200); CSS `.notif-more` em `styles/vision.css`.
- Spec: `docs/013`, "Notificações do sino".
- Testes: `apps/server/test/vision.test.ts` ("não lidas primeiro e todas alcançáveis pelo cursor…"): 35 avisos com as 5 mais recentes lidas — a 1ª página traz as 30 não lidas da mais nova para a mais antiga e a 2ª as 5 lidas; lendo a última da página de 20, a seguinte ainda traz as 10 não lidas que faltavam; cursor inválido dá 400. O fluxo de tela do "Ver mais" não tem e2e.
- Verificação: `pnpm verify:quick`.
