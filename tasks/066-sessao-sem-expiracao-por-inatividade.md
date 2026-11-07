---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit:
---

# Sessão sem expiração por inatividade e cookie sem `Secure` por padrão

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** configuração de sessão
- **Arquivos afetados:** `apps/server/src/auth/session.ts:30-46`, `apps/server/src/routes/auth.ts:24-30`, `apps/server/src/config.ts:76`, `.env.example:24-25`, `docker-compose.yml:75`, `docs/002-usuarios-e-permissoes.md:5`
- **Depende de / relacionado a:** 067
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O "crachá" de login vale 30 dias, mesmo que ninguém use o sistema nesse tempo. Se o administrador esquecer uma opção, o crachá também pode viajar sem criptografia.

### Evidência e análise técnica
- `resolveSession` (`session.ts:30-46`) só confere `expiresAt` (30 dias, `SESSION_DAYS`). O `lastSeenAt` é atualizado, mas nunca usado para expirar.
- `cookieSecure: env.COOKIE_SECURE === 'true'` (`config.ts:76`), com padrão `false` no `.env.example:24-25` e no compose (`:75`).

### Verificação (tentativa de refutação)
- O `Secure` desligado por padrão é configuração documentada ("true atrás de HTTPS") e serve ao dev local em HTTP. O risco depende de a produção esquecer a flag, o que não foi verificado. O que sobra é um aviso no boot.
- Não há decisão documentada sobre ociosidade (`docs/002:5`).

### Impacto
Uma sessão roubada fica válida por até 30 dias, e o cookie pode ir em texto claro se a configuração estiver errada.

## Como reproduzir
Ajustar `sessions.last_seen_at` para 10 dias atrás: a sessão continua válida.

## Solução proposta
- `SESSION_IDLE_HOURS` (padrão sugerido 72), conferido em `resolveSession` por `last_seen_at > now() - interval`. O `last_seen_at` é atualizado a cada 5 min, o que basta para ociosidade em horas.
- Aviso no log do boot quando `COOKIE_SECURE=false` e a URL pública (`PUBLIC_BASE_URL`) começa com `https`.
- Documentar em `docs/002` e no `.env.example`. A duração da ociosidade é decisão de produto.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/auth/session.ts
+++ b/apps/server/src/auth/session.ts
@@
-    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, sql`now()`), eq(users.isActive, true)))
+    .where(
+      and(
+        eq(sessions.id, id),
+        gt(sessions.expiresAt, sql`now()`),
+        gt(sessions.lastSeenAt, sql`now() - make_interval(hours => ${idleHours})`),
+        eq(users.isActive, true),
+      ),
+    )
```

## Critérios de aceite
- [ ] Uma sessão com `last_seen_at` mais antigo que o limite devolve 401.
- [ ] O aviso de boot aparece com URL em HTTPS e cookie não seguro.
- [ ] `docs/002` e `.env.example` atualizados.

## Testes recomendados
Integração: ajustar `last_seen_at` por um UPDATE de teste e esperar 401. Nada disso foi executado nesta auditoria.

## Limitações e suposições
O deploy de produção não foi verificado.

## Análise (triagem)

Confirmado no código (app, 2026-11-07; sem triage, designada pela sessão principal): `resolveSession` só conferia `expires_at` (30 dias); o `last_seen_at`, renovado a cada 5 min, nunca expirava a sessão. `COOKIE_SECURE` segue `false` por padrão para o dev em HTTP. Decisão da sessão principal: `SESSION_IDLE_HOURS` com padrão 72 (0 desliga), conferido no `resolveSession`, e um aviso no boot quando `COOKIE_SECURE=false` e a URL pública (`PUBLIC_BASE_URL`/`APP_URL`) começa com https.

## Resolução (executor)

- `config.ts`: `sessionIdleHours` de `SESSION_IDLE_HOURS` (padrão 72; `0` desliga; inteiro >= 0, senão o boot falha com a mensagem) e `insecureCookieWarning(config)`, que devolve o aviso quando o cookie não é `Secure` e `PUBLIC_BASE_URL` ou `APP_URL` começa com `https://`; `main.ts` o registra com `app.log.warn` no boot da API.
- `auth/session.ts`: `resolveSession(db, token, idleHours)` exige `last_seen_at > now() - make_interval(hours => idleHours)` quando `idleHours > 0`; `app.ts` passa `config.sessionIdleHours`. A sessão ociosa dá 401 (fica na tabela até expirar pela validade, quando o worker a purga).
- Documentado em `.env.example` (`SESSION_IDLE_HOURS=72` e o aviso do `COOKIE_SECURE`), `docker-compose.yml` (serviço `api`) e `docs/002` (validade, ociosidade, `Secure` e o aviso); `docs/018` lembra a produção.
- Testes em `apps/server/test/auth.test.ts`, `describe('ociosidade da sessão e cookie Secure (tarefa 066)')`: 71 h sem uso continua válida (e renova o `last_seen_at`), 73 h dá 401; `SESSION_IDLE_HOURS=0` aceita 20 dias sem uso; valores inválidos (-1, 1.5) recusados; o aviso aparece com `PUBLIC_BASE_URL`/`APP_URL` em https e cookie não seguro, e não aparece em http, sem URL ou com `COOKIE_SECURE=true`.
