---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Listas que só abrem com o mouse, chat sem anúncios ao leitor de tela, e as regras do Biome que pegariam isso desligadas

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** acessibilidade (WCAG 2.1.1 teclado, 4.1.3 mensagens de status, 2.4.3 ordem do foco) e configuração do lint
- **Arquivos afetados:** `apps/web/src/components/titles/TitlesTab.tsx:139-151,187-199`, `apps/web/src/pages/CaixasPage.tsx:74-87`, `apps/web/src/pages/EntitiesPage.tsx:151-176`, `apps/web/src/components/card/PurchasesTab.tsx:134-138`, `apps/web/src/components/card/shared.tsx:64-69`, `apps/web/src/components/calendar/AgendaView.tsx:96`, `apps/web/src/pages/MessagesPage.tsx:134-140`, `apps/web/src/components/messages/HistoryTab.tsx:118`, `apps/web/src/components/reports/EntityReport.tsx:48`, `apps/web/src/components/reports/CategoryReport.tsx:158`, `apps/web/src/components/titles/TitleDrawer.tsx:221`, `apps/web/src/components/contracts/ContractsTable.tsx:55-71`, `apps/web/src/pages/ContractsPage.tsx:285`, `apps/web/src/pages/ContractPage.tsx:511-516,616-620`, `apps/web/src/components/contracts/PaymentsSection.tsx:115-125`, `apps/web/src/components/notes/NotesBrowser.tsx:217-229`, `apps/web/src/components/admin-ai/McpTab.tsx:74-84`, `apps/web/src/components/contracts/DocumentView.tsx:232`, `apps/web/src/agents/ConversationPane.tsx:209-266,487-574,747-759`, `apps/web/src/agents/AgentWindows.tsx:213-222,294-330`, `apps/web/src/agents/AgentsMenu.tsx:68-83`, `biome.json:32-41,48-50`
- **Depende de / relacionado a:** tarefa 115
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Várias listas só abrem o item com o clique do mouse na linha. Quem navega pelo teclado, ou com leitor de tela, não consegue abrir um título pago, uma caixa, uma entidade, uma compra do cartão, um contrato, um documento do contrato, um pagamento, uma anotação nem uma versão antiga do documento, porque o nome é texto solto, não um link nem um botão. Um usuário só leitor numa caixa não tem nenhum controle para abrir um título. No chat do agente, o leitor de tela não avisa quando a resposta chega nem quando o agente pede aprovação, e abrir um agente pelo ícone da barra não leva o cursor para a janela. O verificador de código (Biome) apontaria o problema das linhas, mas as regras estão desligadas.

### Evidência e análise técnica
**A. Linhas clicáveis sem teclado.** O padrão é `<tr className="cursor-pointer" onClick=…>` (ou `<li>`, `<span>`) sem `tabIndex`, sem `role`, sem `onKeyDown` e sem link ou botão que faça o mesmo, com o nome dentro de um `<span>`. Todos os lugares abaixo são o mesmo defeito.

*Telas financeiras:*
- **Títulos** (`TitlesTab.tsx:139-151`): a gaveta abre pelo clique na linha. O único botão é o "Pagar/Receber" (`:187-199`), que aparece só com `canWrite`, saldo em aberto e título não cancelado. Um **leitor** (papel viewer) não tem nenhum controle focável para abrir um título, e quem escreve não abre os pagos nem os cancelados.
- **Caixas** (`CaixasPage.tsx:74-87`) e **entidades** (`EntitiesPage.tsx:151-176`; a célula do nome, `:166-180`, é só `<span>`): a linha navega com `navigate(...)` e o nome é `<span className="row-title">`. Do teclado, só pela paleta ⌘K.
- **Compras do cartão** (`PurchasesTab.tsx:134-138`) e **linhas da fatura** (`card/shared.tsx:64-69`): o único link da linha vai para a entidade, não para a gaveta da compra.
- **Agenda do calendário** (`AgendaView.tsx:96`): o popover com "Baixar" só abre com o mouse. Na grade, os itens são botões, e ali funciona.
- **Destinos do Telegram** (`MessagesPage.tsx:134-140`), **envios** (`HistoryTab.tsx:118`) e **relatório por entidade** (`EntityReport.tsx:48`): expandir ou abrir só pela linha. Em `CategoryReport.tsx:158` há o "expandir tudo" no cabeçalho, mas não há como abrir um grupo só.

*Contratos, documentos e anotações:*
- `ContractsTable.tsx:55-58`: `<tr onClick={() => navigate(/contracts/:id)}>`; o nome é `<span className="row-title">` (`:63`). É a lista principal, a aba da entidade e o painel.
- `ContractsPage.tsx:285`: `<li className="item cursor-pointer" onClick={() => navigate(`/contracts/${row.id}`)}>` do painel "Renovam em breve"/"Encerrados", conteúdo só `<span>`.
- `ContractPage.tsx:511-514` (títulos avulsos) e `:616` (documentos; título em `<span>` na `:618`).
- `PaymentsSection.tsx:115-120`: abrir o título ou a compra da ocorrência.
- `NotesBrowser.tsx:217-221`: abrir a anotação; o título é `<span>` (`:228`); o único foco da linha é o link da entidade.
- `McpTab.tsx:74-77`: expandir o servidor só pelo clique na linha; o chevron é decorativo (`:80`).
- `DocumentView.tsx:232`: "ver esta versão" por `<span className="grow min-w-0 cursor-pointer" onClick={() => setShown(v.id)}>`; os botões ao lado são de outras ações.

*Gavetas.* As gavetas (`TitleDrawer.tsx:221`, `<aside>`) abrem sem mover o foco para dentro. No celular (`.drawer { width: 100% }`, `shell.css:1280`) elas cobrem a tela, e o Tab continua percorrendo a página por trás.

A `AuditPage:178-189` mostra o jeito certo: a linha tem um botão de expandir com `aria-expanded` e `aria-label`.

**B. Chat do agente:**
- A lista de mensagens (`ConversationPane.tsx:209-217`, `.agent-scroll`) não tem `role="log"`/`aria-live`; o indicador "Trabalhando…/Na fila/Aguardando aprovação/Reconectando" (`:244-257`) não tem `role="status"`; o erro do stream (`:258-266`) não tem `role="alert"`.
- O cartão "Aplicar?" (`:487-574`) aparece sem anúncio e sem foco, justamente quando o usuário precisa agir.
- `openThread` (`AgentsMenu.tsx:68-83`) só muda o estado; a janela é um `<section>` num portal no fim do `body` (`AgentWindows.tsx:213-222,294-330`) e nada recebe foco (o compositor, `ConversationPane.tsx:747-759`, não tem `autoFocus`): pelo teclado, a janela fica depois de toda a página.

**C. Regras do Biome desligadas (por que o `pnpm lint` não pega).** `biome.json:32-41` desliga sete regras de `a11y`, e `:48-50` desliga `useExhaustiveDependencies`. Medi quantos diagnósticos cada uma daria hoje (`pnpm exec biome lint --only=<regra> apps packages e2e scripts`, só leitura):

| Regra (desligada) | Diagnósticos |
|---|---|
| `a11y/useKeyWithClickEvents` | 16 |
| `a11y/noStaticElementInteractions` | 14 |
| `a11y/useSemanticElements` | 38 |
| `a11y/noAutofocus` | 38 |
| `a11y/useAriaPropsSupportedByRole` | 7 |
| `a11y/noLabelWithoutControl` | 3 |
| `a11y/noNoninteractiveElementToInteractiveRole` | 1 |
| `correctness/useExhaustiveDependencies` | 35 (em `apps/web/src`) |
| `suspicious/noArrayIndexKey` | 18 |

Revisei os 16 de `useKeyWithClickEvents`. A maioria é falso positivo legítimo (fundo de modal, `ui.tsx:566` e `:625`, `Layout.tsx:89`, `ImageLightbox.tsx:53`, que fecham também por Escape; e `onClick={(e) => e.stopPropagation()}` em células com botões, `AgentsTab.tsx:113`, `PlannedAccount.tsx:106`, `StatementImportPanel.tsx:331`, `:367`). Três são defeitos reais (`EntitiesPage.tsx:152-156`, `ContractsPage.tsx:285` e `DocumentView.tsx:232`, já listados em A), sem nenhum elemento focável que faça a mesma coisa. Em comparação, a lista de lotes de extrato faz certo: a linha é clicável, mas o nome do arquivo é um `<button>` (o e2e usa `getByRole('button', { name: 'extrato-ofx2.ofx' })`, `operacao.spec.ts:192`).

### Verificação (tentativa de refutação)
- `recordDragProps` (`agents/records.ts:15-24`) só acrescenta `draggable` e `onDragStart`, sem `tabIndex`. Não há manipulador global que torne `tr.cursor-pointer` focável: `rg "tabIndex=\{0\}"` no `apps/web` só acha o `RequestsTable`, os gráficos SVG e `components/backup/shared.tsx`. Procurei `onKeyDown`, `tabIndex` e `role="link"` em `EntitiesPage.tsx` e `ContractsPage.tsx`: não há.
- Não há atalho de teclado por linha nas tabelas (a paleta não lista os títulos de uma caixa; a busca da paleta, e a busca global `/api/search` na barra, acham pelo texto, o que é um contorno ruim e não substitui a lista).
- Os e2e clicam com `page.click` na linha. Não há teste com o teclado.
- O projeto já tem os padrões certos: `RequestsTable.tsx:49-56` (`tabIndex={0}` + Enter), `StatementImportPanel.tsx:312-318` (botão no nome do lote), `PdfViewer.tsx:87` (`aria-live`), `AudioRecorder.tsx:169,187` (`role="alert"`/`role="status"`). `AgentsTab`, `ToolKitsTab` e `RulesPanel` têm botão de editar na linha, então não entram. `rg "aria-live|role=\"log\"|role=\"status\"" apps/web/src/agents` só acha o `AudioRecorder`.
- `useExhaustiveDependencies`: nos casos amostrados (`AgentsProvider.tsx:210` com a função pura `topZ`, `AgentsMenu.tsx:44-48` com contadores de recarga), a dependência "a mais" é proposital; não encontrei um fechamento obsoleto confirmado, então essa regra não entra neste achado.

### Impacto
Um leitor que use só o teclado ou leitor de tela não abre os detalhes de nenhum título da caixa, e as listas principais (caixas, entidades, compras, contratos, documentos, anotações, versões) ficam inacessíveis pelo teclado (WCAG 2.1.1). Esses usuários também não percebem a resposta nem o pedido de aprovação do agente (a execução pode ficar parada esperando). Como as regras do Biome estão desligadas, o próximo componente com o mesmo padrão também passa no `pnpm lint`.

## Como reproduzir
1. Entre com um usuário de papel "leitor" numa caixa. A pagar → use só Tab e Enter. Nenhum elemento da tabela recebe foco que abra o título.
2. Em `/caixas`, o Tab passa pelas abas e pula a tabela inteira. Em `/entities`, o foco pula a estrela e vai direto ao próximo controle, sem parar em nenhuma linha; Enter não abre nada.
3. /contracts só com Tab: o foco passa pelos filtros e pula a tabela, e idem no painel de contratos e na lista de versões de um documento markdown do contrato. Contrato → Documentos → Tab: nenhum documento recebe foco.
4. /notes → Tab: só os links de entidade recebem foco; Enter leva à entidade, não à anotação.
5. Com VoiceOver/NVDA, abrir um agente pelo ícone e perguntar algo: nada é lido quando a resposta chega; pedir uma escrita em `ask`: o cartão aparece em silêncio.

## Solução proposta
1. Na coluna principal de cada linha, troque o `<span className="row-title">` por um `<Link>` (caixas, entidades, contratos: rotas reais; título, compra) ou por um `<button type="button" className="row-title">` que abre a gaveta (títulos, compras, agenda, documento, anotação, versão), como em `StatementImportPanel.tsx:312-318`. O `onClick` da `<tr>` continua, para quem usa o mouse. No `McpTab`, o chevron vira `<button aria-expanded>`. Opcional: um `ClickableRow` no `ui.tsx`.
2. Nas linhas que expandem (destinos, envios, relatórios), um botão com `aria-expanded` na primeira célula, como na `AuditPage`.
3. Ao abrir uma gaveta, foque o título dela (`tabIndex={-1}` no `.dh .t`) e devolva o foco à linha ao fechar. Em tela estreita, trate a gaveta como `role="dialog"` com o foco preso (`useModalFocus` já existe em `ui.tsx:482-521`).
4. Chat: `.agent-scroll` com `role="log"` `aria-live="polite"` `aria-relevant="additions"`; a bolha ao vivo fora da região viva enquanto digita (para não ler token a token) e a mensagem final dentro dela; indicador com `role="status"`; erro com `role="alert"`.
5. Ao surgir confirmação pendente, anunciar ("O agente pede aprovação para N ações") e levar o foco ao cartão se o foco estava no compositor.
6. Ao abrir/restaurar uma janela (menu, doca, link do sino), focar o compositor (ou o título, se somente leitura).
7. Biome: religar `a11y/useKeyWithClickEvents` e `a11y/noStaticElementInteractions` como `error`, com `// biome-ignore lint/a11y/...: fundo do modal; fecha por Escape` nos falsos positivos listados acima (são ~11 lugares). Avaliar depois `useSemanticElements` e `noAutofocus` (38 cada) com a mesma triagem, em outra tarefa.

### Diff/patch proposto — NÃO APLICADO
```tsx
// apps/web/src/pages/ContractsPage.tsx
<li key={row.id} className="item cursor-pointer" onClick={() => navigate(`/contracts/${row.id}`)}>
  <span className="grow min-w-0">
-   <span className="row-title">{row.name}</span>
+   <Link className="row-title" to={`/contracts/${row.id}`} onClick={(e) => e.stopPropagation()}>{row.name}</Link>
```
```json
// biome.json
"a11y": {
-  "noStaticElementInteractions": "off",
-  "useKeyWithClickEvents": "off",
```

## Critérios de aceite
- [ ] Com o teclado: Tab chega ao nome do título, Enter abre a gaveta, o foco vai para a gaveta, e Esc devolve o foco à linha.
- [ ] O mesmo para caixas, entidades, compras, linhas da fatura, agenda, contratos, documentos, pagamentos, anotações, versões do documento e servidores MCP, com foco visível e anunciados como link ou botão.
- [ ] Um leitor abre qualquer título da lista só com o teclado.
- [ ] O leitor de tela lê a resposta final e o pedido de aprovação.
- [ ] Abrir um agente pelo menu deixa o foco no compositor da janela.
- [ ] `useKeyWithClickEvents` e `noStaticElementInteractions` ligadas, `pnpm lint` passando, cada exceção com `biome-ignore` justificado.

## Testes recomendados
- e2e em `fluxo-principal.spec.ts`: depois de criar o título, `page.keyboard.press('Tab')` até `getByRole('button', { name: <descrição> })`, Enter, e conferir que `getByRole('complementary', { name: <descrição> })` está visível e com o foco dentro.
- `e2e/tests/contratos.spec.ts`: abrir um contrato pela lista por `getByRole('link', { name })` + Enter (e pela lista, com o teclado, o contrato do painel); `e2e/tests/anotacoes.spec.ts`: abrir uma anotação da tabela por `getByRole('button', { name: título })`; `e2e/tests/tags.spec.ts` (já abre uma entidade pela lista): trocar o clique na célula por `getByRole('link', { name: tagged }).press('Enter')`.
- `e2e/tests/agentes.spec.ts`: depois de `agents-thread-open`, `expect(page.getByTestId('agent-composer')).toBeFocused()`; `getByRole('log')` na lista e `getByRole('status')` no indicador.

## Limitações e suposições
Nada foi executado nem testado com leitor de tela; a conclusão vem da leitura do JSX/HTML gerado. O Biome foi rodado só para contar diagnósticos (sem `--write`). As tabelas `AgentsTab`, `ToolKitsTab` e `ContractPage` foram citadas por um revisor como tendo o mesmo padrão; aqui só entram os pontos listados acima.

## Análise (triagem)

## Resolução (executor)
