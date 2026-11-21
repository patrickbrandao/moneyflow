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

# Esc fecha todas as camadas de uma vez: fechar a lista do seletor de entidade descarta o formulário inteiro

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** teclado / pilha de camadas
- **Arquivos afetados:** `apps/web/src/components/ui.tsx:358-376,550-557,612-619`, `apps/web/src/components/forms.tsx:89`, `apps/web/src/components/entity/tags.tsx:156`, `apps/web/src/components/titles/TitleDrawer.tsx:73-79,342-350`, `apps/web/src/components/card/PurchaseDrawer.tsx:22-28`, `apps/web/src/components/entity/EntityTagsModal.tsx:33,100-110`, `apps/web/src/components/attachments/AttachmentsPanel.tsx:89-98,215-239`, `apps/web/src/pages/MessagesPage.tsx:33-40`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quem aperta Esc para fechar a lista de sugestões da entidade, dentro de "Novo título", perde o título inteiro, porque o mesmo Esc fecha também a janela. O mesmo vale para uma confirmação aberta de dentro de outra janela ou de uma gaveta: o Esc que cancela a pergunta fecha também o que está atrás dela.

### Evidência e análise técnica
Cada camada registra o próprio `keydown` em `document` e nenhuma verifica se está no topo nem chama `stopPropagation`:

- `useClickOutside` fecha no Esc (`ui.tsx:364-369`). Usam esse gancho o `EntityPicker` (`forms.tsx:89`), o `TagPicker` (`tags.tsx:156`), o `Menu` e o popover do calendário.
- `ConfirmProvider` cancela no Esc (`ui.tsx:550-557`), e `Modal` fecha no Esc (`ui.tsx:612-619`).
- As gavetas `TitleDrawer` (`:73-79`) e `PurchaseDrawer` (`:22-28`) fecham no Esc quando `!modal`, mas só conhecem os modais do próprio estado.

Combinações que perdem trabalho ou contexto:
1. `EntityPicker` aberto dentro de `TitleFormModal`, `PurchaseFormModal`, `CaixaFormModal`, `AdjustmentModal` ou `LinkModal`: Esc fecha a lista **e** o modal, e tudo o que foi digitado se perde.
2. `TagPicker` dentro de `EntityFormModal`: idem, e se perde também o resultado da consulta de CNPJ.
3. Modal dentro de modal: `TagFormModal` aberto de `EntityTagsModal` (`EntityTagsModal.tsx:100-110`). Esc fecha as duas janelas.
4. Confirmação dentro de modal: excluir uma tag (`EntityTagsModal.tsx:33`) ou um anexo dentro de `AttachmentsModal` (`AttachmentsPanel.tsx:89-98`, `:215-239`). Esc cancela e fecha a janela de trás.
5. Confirmação ou modal fora do estado da gaveta: "Cancelar título" e "Excluir" (`TitleDrawer.tsx:94-140`) e o `PlannedAccountModal`, que vive no estado de `PlannedAccountButton` (`TitleDrawer.tsx:344`). Esc fecha também a gaveta do título. Na compra, o mesmo com "Excluir" (`PurchaseDrawer.tsx:36-49`).

A `MessagesPage` (`:36`) já contorna o problema com `!document.querySelector('.modal')`, que cobre o `Modal` e a confirmação, ambos com a classe `modal`. As gavetas do título e da compra não adotaram isso.

### Verificação (tentativa de refutação)
- `useClickOutside` e `Modal` registram os ouvintes em `document`, sem `capture`, na ordem de montagem. Os dois disparam no mesmo evento. Não há `event.defaultPrevented` nem `stopImmediatePropagation` em nenhum deles.
- O `Modal` não guarda o estado do formulário: quem fecha é o pai (`setNew(null)` em `TitlesTab:227`), e o estado se perde ao desmontar.
- A paleta (`cmdk`, Radix) trata o próprio Esc. Ela fica fora desta análise.

### Impacto
Frequente para quem usa teclado: Esc é o gesto natural para fechar uma lista de sugestões. Perde-se o formulário inteiro sem confirmação.

## Como reproduzir
1. Caixa → A pagar → Novo título. Preencha descrição e valor.
2. Clique no campo da entidade (a lista abre) e aperte Esc.
3. O modal fecha e os dados digitados somem.

## Solução proposta
1. Uma pilha de camadas em `ui.tsx` (ou num `ui/layers.ts` novo): `useEscapeLayer(active, onEscape)` empilha ao ativar e desempilha ao desativar. Um único ouvinte em `document` chama só a camada do topo e faz `preventDefault`.
2. Usar o gancho em `useClickOutside` (só a parte do Esc), `Modal`, `ConfirmProvider`, `TitleDrawer`, `PurchaseDrawer`, `SubscriptionsDrawer`/`MessagesPage` e no `ItemPopover`. Os pickers dentro de um modal passam a ser o topo enquanto a lista está aberta.
3. Opcional: perguntar antes de fechar um formulário alterado ("Descartar o que foi digitado?") quando o Esc ou o clique fora chegam com o formulário sujo.
4. Aproveitar para tirar de `ui.tsx` (668 linhas) o bloco de foco, confirmação e modal (`ui.tsx:466-642`) para `components/ui/modal.tsx`, junto com a pilha.

## Critérios de aceite
- [ ] Esc com a lista do `EntityPicker` aberta fecha só a lista. O segundo Esc fecha o modal.
- [ ] Esc numa confirmação aberta de dentro de um modal ou de uma gaveta fecha só a confirmação.
- [ ] Esc no `TagFormModal` volta ao `EntityTagsModal`.
- [ ] Esc no `PlannedAccountModal` não fecha a gaveta do título.

## Testes recomendados
e2e em `fluxo-principal` (ou novo `teclado.spec.ts`): abrir "Novo título", digitar, focar a entidade, `keyboard.press('Escape')` e conferir que o diálogo continua visível com o texto. Um segundo caso com a confirmação de "Cancelar título" dentro da gaveta.

## Limitações e suposições
Nada foi executado. As janelas dos agentes (`src/agents/`, outra área) podem ter ouvintes de Esc próprios e precisam entrar na mesma pilha.

## Análise (triagem)

## Resolução (executor)
