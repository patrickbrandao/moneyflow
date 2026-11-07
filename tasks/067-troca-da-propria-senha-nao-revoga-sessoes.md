---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# O admin que troca a própria senha pela tela de Usuários não encerra as outras sessões

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência
- **Subcategoria:** gestão de sessão
- **Arquivos afetados:** `apps/server/src/services/users.ts:105-125,163-171`, `apps/web/src/pages/UsersPage.tsx:254-289`
- **Depende de / relacionado a:** 066
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Quando o admin troca a própria senha pela tela de Usuários, por exemplo por suspeitar de invasão, quem já estava logado com a conta dele em outro lugar continua logado.

### Evidência e análise técnica
- `users.ts:121-122`: o comentário diz "Trocar a senha encerra as sessões do usuário", mas o código faz `if (input.password !== undefined && !self) await tx.delete(sessions)...`. No próprio usuário, nada é apagado.
- O caminho de Minha conta (`changeOwnPassword`, `:163-171`) apaga as outras sessões (`ne(sessions.id, currentSessionId)`).
- A UI (`UsersPage.tsx:254-289`) deixa o admin preencher "nova senha" no próprio usuário.

### Verificação (tentativa de refutação)
- Refutado: "sem pedir a senha atual" não é achado. Quem tem a sessão de admin já pode revelar a própria senha por `admin_reveal_password`.
- O `!self` parece servir para não derrubar a sessão atual, mas acaba poupando todas.
- `docs/002` não trata do assunto.

### Impacto
A troca de senha por esse caminho não expulsa um invasor.

## Como reproduzir
Admin com duas sessões. Numa delas, `PATCH /api/users/<próprio id>` com `password`. A outra sessão continua válida.

## Solução proposta
- No caso `self`, apagar as sessões menos a atual, como faz o `changeOwnPassword`. Para isso, a rota passa `request.sessionId` ao serviço.
- Documentar em `docs/002`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/users.ts
+++ b/apps/server/src/services/users.ts
@@
     // Trocar a senha encerra as sessões do usuário (desativar já faz isso por trigger).
-    if (input.password !== undefined && !self) await tx.delete(sessions).where(eq(sessions.userId, id));
+    // Na própria conta, mantém só a sessão atual (como changeOwnPassword).
+    if (input.password !== undefined) {
+      const keep = self && currentSessionId ? ne(sessions.id, currentSessionId) : undefined;
+      await tx.delete(sessions).where(keep ? and(eq(sessions.userId, id), keep) : eq(sessions.userId, id));
+    }
```
A assinatura de `updateUser` passa a receber `currentSessionId`.

## Critérios de aceite
- [ ] Admin com duas sessões troca a própria senha por PATCH: a sessão atual continua válida e a outra devolve 401.
- [ ] `docs/002` atualizada.

## Testes recomendados
`apps/server/test/users.test.ts`, no cenário de "Como reproduzir". Nada disso foi executado nesta auditoria.

## Limitações e suposições
Nenhuma relevante.

## Análise (triagem)

Confirmado no código (app, 2026-11-07; sem triage, designada pela sessão principal): `updateUser` (`services/users.ts`) só apagava as sessões quando `!self`; o admin trocando a própria senha por `PATCH /api/users/:id` não derrubava nenhuma outra sessão. O `ServiceContext` não carregava a sessão da requisição, então o serviço não tinha como poupar só a atual.

## Resolução (executor)

- `ServiceContext.sessionId` (novo, `context.ts`): o `onRequest` de `app.ts` preenche com a sessão do cookie. As tools de agente executadas na decisão da API herdam o contexto da requisição (`{ ...ctx, actorKind: 'agent' }` em `conversations.ts`), então a troca da própria senha por um agente pelo console também mantém a sessão do console.
- `updateUser`: trocar a senha sempre encerra as sessões do usuário; na própria conta, todas menos `ctx.sessionId` (como `changeOwnPassword`). Sem sessão (o `/mcp` por token pessoal, o worker), a troca da própria senha encerra todas.
- `docs/002`: a regra da troca de senha e das sessões.
- Teste: `apps/server/test/auth.test.ts`, "o admin que troca a própria senha em Usuários mantém só a sessão atual (tarefa 067)" — admin com duas sessões troca a própria senha por PATCH: a atual segue válida e a outra dá 401; trocar a de outro usuário derruba as duas sessões dele. (O `users.test.ts` citado não existe; os testes de usuários ficam no `auth.test.ts`.)
