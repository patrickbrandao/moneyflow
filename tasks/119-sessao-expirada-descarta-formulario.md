---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: d6f991c
---

# Sessão que cai desmonta o console inteiro e perde o formulário que estava sendo preenchido

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** tratamento de 401 no cliente
- **Arquivos afetados:** `apps/web/src/lib/api.ts:22-27,53-56`, `apps/web/src/lib/auth.tsx:52-60`, `apps/web/src/App.tsx:47-58`, `apps/web/src/components/shell/Notifications.tsx:61-65`, `apps/web/src/components/ui.tsx:655-668`, `apps/web/src/lib/upload.ts:22-26`, `apps/web/src/lib/download.ts:23-27`
- **Depende de / relacionado a:** tarefas 066 e 067 (ociosidade e revogação das sessões)
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se a sessão termina enquanto alguém digita um título, uma baixa ou uma entidade, a tela troca na hora para o login e tudo o que foi digitado some. Depois de entrar de novo, o formulário reabre vazio, ou nem reabre.

### Evidência e análise técnica
- `request()` chama `onUnauthorized` em qualquer 401 fora do login (`api.ts:55`). O handler do `AuthProvider` faz `setUser(null)` (`auth.tsx:53-58`).
- `App` troca `<Console />` por `<LoginPage />` quando `user` é nulo (`App.tsx:57`). Com isso desmontam as rotas, os modais abertos, o estado dos formulários, as gavetas e o `CommandProvider`.
- O sino consulta `/api/notifications` a cada 60 s enquanto a aba está visível (`Notifications.tsx:61-65`, `usePolling` em `ui.tsx:656-668`). Assim, o 401 não espera o usuário salvar: o formulário some no meio da digitação, no primeiro tique depois de a sessão cair.
- A sessão cai por motivos que não dependem desta aba: validade de `SESSION_DAYS`, troca de senha em outro aparelho (que encerra as outras sessões, tarefa 067), o admin desativar o usuário ou trocar a senha dele, e a restauração de um dump (`docs/002:6`).
- Há uma inconsistência no sentido oposto: `upload()` e `downloadFile()` não chamam o handler (`upload.ts:22-26`, `download.ts:23-27`). Um anexo enviado com a sessão vencida mostra só um toast "não autenticado" e deixa o console de pé até a próxima chamada de `api`.

### Verificação (tentativa de refutação)
- O servidor só responde 401 por sessão ausente ou inválida (`app.ts:129`) e por credencial errada no login (`routes/auth.ts:19`). A troca de senha com a senha atual errada responde 422 (`services/users.ts:171`), então o handler não dispara indevidamente: o 401 significa mesmo sessão perdida.
- A URL é preservada (`BrowserRouter`), mas o estado dos modais não fica nela. Os que abrem por `?new=1` reabrem vazios, e os que vivem em `useState` (baixa, edição) não reabrem.
- Não há rascunho em `localStorage` para os formulários do domínio.

### Impacto
É raro, mas destrutivo: perde-se tudo o que foi digitado, às vezes um formulário longo (título com série e ajustes, compra parcelada, cadastro de entidade com consulta de CNPJ).

## Como reproduzir
1. Abra "Novo título a pagar" e preencha os campos sem salvar.
2. Em outra aba (ou com `DELETE FROM sessions` no ambiente de desenvolvimento), troque a senha em Minha conta. Isso encerra as outras sessões.
3. Espere até 60 s. A primeira aba cai no login e o formulário se perde.

## Solução proposta
1. Separe "sessão expirou" de "deslogado". O handler marca `expired = true` e mantém `user`. O `Console` continua montado, e um modal de login por cima (o mesmo `LoginPage` em forma de `Modal`) pede usuário e senha.
2. Depois do login no modal, quem recebeu o 401 pode repetir: a fila de `request` guarda as promessas pendentes com 401 e as repete após o login, ou ao menos devolve um `ApiError` com `code: 'session_expired'` para o formulário manter o estado e pedir "salve de novo".
3. Enquanto `expired`, pause o `usePolling` (sino, lembretes), para não disparar mais 401.
4. Faça `upload()` e `downloadFile()` chamarem o mesmo handler no 401.
5. Se outro usuário entrar no modal, aí sim derrube o console.

## Critérios de aceite
- [ ] Com a sessão revogada, o formulário aberto continua na tela com o que foi digitado, e um modal pede o login.
- [ ] Depois de entrar de novo, salvar funciona sem redigitar.
- [ ] Um upload com a sessão vencida abre o mesmo modal.
- [ ] Entrar com outro usuário no modal volta ao console limpo.

## Testes recomendados
e2e novo (por exemplo `sessao.spec.ts`): preencher o formulário do título, apagar a sessão pela API de outra sessão (troca de senha), esperar o tique do sino (ou forçar com `page.clock`) e conferir que o formulário continua preenchido e o modal de login aparece.

## Limitações e suposições
Nada foi executado. O tempo até cair (até 60 s) depende da sondagem do sino. Os lembretes (`ReminderAlarm`, fora desta área) também sondam e podem antecipar o 401.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `request()` chamava o handler em todo 401 e o `AuthProvider` zerava o usuário, o que trocava o `Console` pelo `LoginPage` e desmontava os formulários; o sino sondava a cada 60 s; `upload()` e `downloadFile()` não chamavam o handler.

## Resolução (executor)
Sessão expirada separada de deslogado. `apps/web/src/lib/api.ts`: no 401 (fora das rotas da própria sessão: login, logout, me), `recoverSession` chama o handler, que devolve uma promessa resolvida depois do login de novo; se o mesmo usuário entrar, o pedido é repetido (o 401 sai da checagem da sessão, antes de qualquer rota, então nada foi gravado); senão falha com `ApiError` `session_expired`. `upload()` e `downloadFile()` usam o mesmo caminho. `apps/web/src/lib/auth.tsx`: `expired` no contexto, os pedidos à espera numa fila, `login` resolve a fila (repetir se for o mesmo usuário) e `logout` a encerra; o aviso `notice` do login saiu (o console não cai mais por 401). `App.tsx`: o `Console` fica montado (com `key` pelo usuário, para recomeçar limpo se entrar outro, voltando a `/`) e a `SessionExpiredDialog` nova (`components/shell/SessionExpiredDialog.tsx`) abre por cima de tudo, com o usuário preenchido, "Entrar" e "Sair"; não fecha no Esc (camada da tarefa 115) nem no clique fora. `usePolling` não dispara enquanto a sessão está caída (sino, lembretes). `useAction` não mostra toast do `session_expired` (a janela já explica). Textos em `t.auth.expiredDialog`. Spec 002 (nova regra) e a linha dela no `docs/INDEX.md` atualizadas.

Testes: e2e novo `e2e/tests/sessao.spec.ts` (não rodado aqui): usuário novo preenche "Nova entidade", o admin troca a senha dele por outro contexto, o "Salvar" abre a janela da sessão com o formulário intacto, o Esc não fecha nada, e o login com a senha nova repete o salvar e abre a ficha da entidade. Verificação: `pnpm verify:quick`.
