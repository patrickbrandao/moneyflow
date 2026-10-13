---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-13
commit: d35f8c8
---

# Trocar ou dispensar o espelho ao lançar a linha do extrato como título

## Descrição
Desde a tarefa 008, lançar uma linha do extrato como "título já baixado" (`POST /api/statement-lines/:id/create`, modo `title`) espelha o título na caixa principal da entidade, como num título novo (spec 006). O endpoint já aceita `mirrorCaixaId` (null = sem espelho; omitido = principal da entidade) e `mirrorCategoryId`, mas o modal da conciliação (`apps/web/src/components/reconciliation/LineModals.tsx`, `CreateModal`) não mostra nem envia nada: o usuário não vê o espelho, não troca a caixa e não o dispensa. O esperado é o mesmo do formulário de título: a caixa principal da entidade pré-selecionada, trocar por outra caixa dela, escolher a categoria do lado espelho ou "Sem espelho".

## Como reproduzir
Conciliação de uma conta → importar um OFX → numa linha nova, "Lançar" → modo "Título já baixado" com uma entidade titular de duas caixas: não há campo de espelho; o título nasce espelhado na principal.

## Análise (triagem)
Só frontend (e um texto em `packages/shared`). O formulário de título (`TitleFormModal.tsx`) já tem a escolha do espelho, embutida; extrair para um componente e usar nos dois. Spec 009 (lançar a partir da linha) e 006. Executor: app.

## Resolução (executor)
- `apps/web/src/components/titles/MirrorFields.tsx`: `useMirrorChoice` (carrega as caixas da entidade e pré-seleciona a principal), `mirrorPayload` (corpo para a API) e `MirrorFields` (caixa da contraparte e categoria no espelho, com o aviso de aceite pendente sem permissão). O `TitleFormModal` passou a usá-los, sem mudança de comportamento, exceto um caso: enquanto as caixas da entidade ainda carregam, o espelho é omitido (o servidor usa a principal) em vez de enviado como `null` (o título nascia sem espelho se o usuário salvasse antes de carregar).
- `CreateModal` (conciliação), modo "Título já baixado": mostra `MirrorFields` (direção pelo sinal da linha) e envia `mirrorCaixaId`/`mirrorCategoryId`. Texto de ajuda do modo atualizado (`t.statements.modeHints.title`); `t.title.mirrorCategoryAuto` substitui o literal "Automática".
- Testes: `apps/server/test/statements.test.ts` ("lança a linha como título baixado com o espelho escolhido na tela": outra caixa da entidade com a categoria do espelho, principal por padrão, dispensado e caixa alheia recusada com a linha ainda nova); e2e `e2e/tests/operacao.spec.ts` ("importar OFX de exemplo e conciliar": lança a linha "Cliente Ômega" pela tela, confere a principal pré-selecionada, troca para a outra caixa do cliente e verifica o espelho).
- Spec 009 atualizada.
