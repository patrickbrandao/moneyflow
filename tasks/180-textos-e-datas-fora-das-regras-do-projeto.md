---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Textos pt-BR fixos fora do `t` do shared e datas no fuso do navegador nas telas

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** DX
- **Subcategoria:** violação das regras de UI (textos por `t`, datas no fuso de SP)
- **Arquivos afetados:** `apps/web/src/pages/UsersPage.tsx:45-68,84,109,126,261,266,332-356`, `apps/web/src/components/titles/TitleDrawer.tsx:97-127,224,268,300-303,336,444`, `apps/web/src/components/titles/TitleFormModal.tsx:115-116,131,157,162,219,285,304`, `apps/web/src/components/titles/TitlesTab.tsx:19-24,84-85,127,137,208`, `apps/web/src/components/titles/SettlementModal.tsx:57,59,73,82,88,121,132,146`, `apps/web/src/pages/EntityPage.tsx:120-142,182,237-349`, `apps/web/src/components/entity/ChildModals.tsx:72,91,105,127,162-166,213,233,322-341`, `apps/web/src/pages/AccountPage.tsx:29-30,55,64-70,86,108`, `apps/web/src/components/caixa/AccountsTab.tsx:59-60,73,94-96,220,226,368-371,389`, `apps/web/src/components/caixa/StatementTab.tsx:39,44,46,103,124`, `apps/web/src/pages/OverviewPage.tsx:29-30,35,72,97-101,154,162-166`, `apps/web/src/pages/CaixasPage.tsx:30,43-44,56,67-70`, `apps/web/src/pages/TransfersPage.tsx:29-34,41,50,81,152,156,182,199`, `apps/web/src/pages/CategoriesPage.tsx:65-66,81,99,138,147-150,169,180,250,266-286`, `apps/web/src/components/caixa/MembersTab.tsx:23-41,50,139,151`, `apps/web/src/components/TitleMiniTable.tsx:16-20`, `apps/web/src/components/shell/Layout.tsx:96-97,113`, `apps/web/src/components/shell/Sidebar.tsx:88-89`, `apps/web/src/components/shell/CommandPalette.tsx:85,93-107`, `apps/web/src/components/shell/UserMenu.tsx:16-23`, `apps/web/src/pages/NotFoundPage.tsx:10-14`, `apps/web/src/components/caixa/account-charts.tsx:268`, `apps/web/src/components/card/PurchaseDrawer.tsx:67`, `apps/web/src/components/reconciliation/ImportModal.tsx:221,231,321,385,576,631,796-801`, `apps/web/src/components/reconciliation/RulesPanel.tsx:55`, `apps/web/src/pages/ReconcileRecipesPage.tsx:207-221,274`, `apps/web/src/components/notes/NoteCalendar.tsx:137,167,172`, `apps/web/src/pages/ContractPage.tsx:146,619,627`, `apps/web/src/components/contracts/ContractsTable.tsx:68`, `apps/web/src/agents/AgentWindows.tsx:84`, `apps/web/src/components/admin-ai/PricesTab.tsx:137,205`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A regra do projeto é que todo texto da tela venha do dicionário do pacote compartilhado, e que as datas sigam o horário de Brasília. As telas mais antigas (títulos, baixas, entidades, caixas, usuários, categorias, a casca do console) e algumas das mais novas (conciliação, contratos, anotações, agentes) ainda escrevem textos direto no código. Isso duplica frases, deixa a mesma ação com nomes diferentes e impede revisar o vocabulário num lugar só. Uma data no cabeçalho da janela do agente usa o fuso do computador em vez do horário de Brasília: fora do fuso de SP, o dia aparece diferente do mostrado na lista.

### Evidência e análise técnica
Regra do AGENTS.md: "Textos em pt-BR vindos de `@moneyflow/shared` (`t`)" e "datas de negócio … no fuso `America/Sao_Paulo`". Não há exceção para o shell nem para o F1. O Biome não aponta texto em JSX, e não há lint para isso. Os módulos mais novos (cartão, calendário, mensagens, backup, relatórios, entrada) já usam `t` de forma consistente; a dívida está concentrada nas telas da F1, no shell do template e nas telas listadas abaixo.

**A. Telas da F1 e shell (amostra; a lista completa está nos arquivos afetados):**
- Toasts e confirmações: `'Título cancelado.'`, `'Título reaberto.'`, `title: 'Cancelar o título?'` (`TitleDrawer.tsx:97,103,116`), `'Baixa registrada.'` (`SettlementModal.tsx:73`), `'Título criado.'` (`TitleFormModal.tsx:157`), `'Salvo.'` (`ChildModals.tsx:72`), `'Removido.'` (`EntityPage.tsx:121`), `'Usuário criado.'` (`UsersPage.tsx:266`), `'Transferência registrada.'` (`TransfersPage.tsx:156`).
- Validação local: `'Escolha a entidade.'`, `'Escolha a categoria.'` (`TitleFormModal.tsx:115-116`), `'A senha precisa de ao menos 6 caracteres.'` (`UsersPage.tsx:261`, `AccountPage.tsx:29`), `'Escolha contas diferentes.'` (`TransfersPage.tsx:152`).
- Cabeçalhos e rótulos: `<th>Vencimento</th>`, `<th>Título</th>`, `<th>Situação</th>` (`TitleMiniTable.tsx:16-20`), `<th>Lançamento</th>` (`StatementTab.tsx:103`), `<th>Seu papel</th>` (`CaixasPage.tsx:56`), "Entrada" e "Saída" (`AccountsTab.tsx:368-371`), "Total" no centro da pizza (`account-charts.tsx:268`).
- A casca e a acessibilidade: `aria-label="Exibir o menu"` (`Layout.tsx:96-97`), `"Recolher o menu"` (`Sidebar.tsx:88-89`), `"Buscar"` (`Layout.tsx:113`), "Digite para filtrar", "Buscando…", "Nada encontrado." (`CommandPalette.tsx:93-107`), "Minha conta", "Tema claro", "Sair" (`UserMenu.tsx:16-23`), "Fechar (Esc)" (`TitleDrawer.tsx:224`, `PurchaseDrawer.tsx:67`).
- Duplicação real: a mesma regra de senha em duas telas com textos próprios, e "Escolha…" repetido em vários `<option>`, enquanto `t.common.choose` já existe (usado em `DestinationFormModal.tsx:109`).

**B. Conciliação, contratos, anotações e agentes:**
- `ImportModal.tsx`: `venc.` (`:221`), ` em ` (`:231`, `:385`), `'trocar'` (`:321`), `` `${s.mappingName}: obrigatório.` `` (`:576`), `'Escolha…'` (`:631`), `linha(s) lidas`, `com problema (ex.: …)` e `` `linha ${e.row}` `` (`:796-801`).
- `RulesPanel.tsx:55`: rótulo da paleta `` `${s.newRule} em ${targetName}` ``.
- `ReconcileRecipesPage.tsx:274`: `Variável desconhecida:` (o `AgentsTab` usa `g.unknownVariables` para a mesma mensagem); `:207-221`: valores de exemplo da prévia fixos no código.
- `NoteCalendar.tsx:137,167,172`: `` `${monthLabel(m)} de ${year}` `` (título e `aria-label`).
- `ContractPage.tsx:146` e `ContractsTable.tsx:68`: `nº`; `ContractPage.tsx:619,627`: `'PDF'`.

**C. Datas no fuso do navegador:**
- `AgentWindows.tsx:84` usa `new Date(archivedAt).toLocaleDateString('pt-BR')` (fuso do navegador); a lista das sessões anteriores usa `formatDateTime` do shared (`PreviousSessions.tsx:106`, fuso de SP). Uma sessão finalizada às 22h30 de SP aparece com o dia seguinte no cabeçalho para um navegador em UTC.
- `PricesTab.tsx:137,205`: o `datetime-local` da vigência do preço é interpretado no fuso do navegador (`new Date(validFrom)`), mas exibido em SP (`formatDateTime`, `:69`).
- Nenhum hex de cor e nenhum valor monetário fora de `Money`/`formatAccounting` foram achados na área de B e C (`rg "#[0-9a-f]{3,8}"`).

### Verificação (tentativa de refutação)
- `AGENTS.md`, "Regras da aplicação": "Textos em pt-BR vindos de `@moneyflow/shared` (`t`)".
- Conferido que nenhuma das strings de B existe em `packages/shared/src/i18n` para reaproveitar diretamente (exceto a de variável desconhecida, que existe em `t.agentsUi.admin.agents.unknownVariables`).

### Impacto
Manutenção: vocabulário divergente entre telas ("Liquidados" na aba e "Pago" no selo; "Remover" e "Excluir"), textos de acessibilidade fora de revisão, e o dicionário do shared não serve como fonte única. A data do cabeçalho da sessão pode divergir da lista fora do fuso de SP. Pequeno em efeito, mas constante em custo de revisão.

## Como reproduzir
- `rg -n ">[A-ZÀ-Ú][a-zà-ú]+[^<{]*<|'[A-ZÀ-Ú][^']*\\.'" apps/web/src/pages apps/web/src/components/titles apps/web/src/components/shell`
- Abrir "Importar extrato", escolher um CSV: "trocar", "Escolha…" e "N linha(s) lidas" vêm do código.
- Com o sistema operacional em UTC, finalizar uma sessão após as 21h de SP: o cabeçalho da janela de leitura mostra o dia seguinte ao da lista "Sessões anteriores".

## Solução proposta
1. Mover os textos para `packages/shared/src/i18n` (áreas `titles`, `entities`, `users`, `shell`, e `areas/statements.ts`, `notes.ts`, `contracts.ts`, `agents-ui.ts`), reaproveitando as chaves que já existem (`t.common.choose`, `t.common.close`), e trocar os literais.
2. Fazer por tela, num commit por área, começando pelos toasts e pelas validações (os textos que o usuário mais vê) e pelos `aria-label`.
3. `AgentWindows.tsx:84`: usar `formatDateTime` do shared, como a lista, ou um helper só de data com `timeZone: TIME_ZONE` (cortar o ISO com `slice(0, 10)` não serve: é a data em UTC).
4. `PricesTab`: converter o `datetime-local` como horário de SP (helper do shared), ou dizer no hint que é o horário local do navegador.
5. Opcional: uma regra simples no `verify:quick` (rg) que acuse literais com letra acentuada em `.tsx` fora de `i18n`.

## Critérios de aceite
- [x] Os arquivos listados não têm mais literais pt-BR em JSX, toasts, `confirm` nem `aria-label`; `rg` pelos literais listados não acha mais nada nos componentes.
- [x] Os e2e que procuram por texto continuam passando (os textos não mudam, só a origem).
- [x] O cabeçalho da sessão finalizada mostra a mesma data da lista.

## Testes recomendados
Nenhum comportamento muda nos textos: os e2e existentes (que usam `getByRole(..., { name })` com estes textos) cobrem a regressão. Em `packages/shared/test/`, se entrar um helper de data no fuso de SP para o cabeçalho, teste com um instante às 23h30 de SP (02h30 UTC do dia seguinte).

## Limitações e suposições
Levantamento por `rg` e leitura, não exaustivo linha a linha nos arquivos grandes; pode haver outros literais não achados. Os dois levantamentos foram feitos por áreas distintas e as áreas de um não foram varridas pelo outro.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado no código atual: os literais pt-BR das listas A e B (toasts, confirmações, validações, cabeçalhos, `aria-label`/`title`, placeholders e as frases compostas da conciliação, contratos e anotações), `AgentWindows.tsx` com `toLocaleDateString('pt-BR')` no fuso do navegador e o `datetime-local` do `PricesTab` lido pelo `new Date` (fuso do navegador). Os dois casos achados no lote anterior também se confirmaram: `ContractPage.tsx` cortava `lastEditedAt` com `slice(0, 10)` (dia em UTC) e `EntrySources.tsx` usava o `dhEmi` cru (`slice(0, 10)`) na competência e na data mostrada.

## Resolução (executor)
Textos: os literais pt-BR dos arquivos listados (toasts, confirmações, validações, cabeçalhos, `aria-label`/`title`, placeholders, estados vazios) passaram para o `t`, com o mesmo texto de antes (os e2e que procuram por texto continuam valendo). Chaves novas perto das do mesmo assunto em `packages/shared/src/i18n/pt-BR.ts`: `user.page`/`user.account` e a regra de senha única `user.passwordTooShort`/`passwordMismatch`/`confirmNewPassword` (a troca de senha em Minha conta passa a dizer "A senha precisa de ao menos 6 caracteres.", como o cadastro), `title.drawer`/`title.form`/filtros e colunas da lista de títulos, `settlement.*` (baixa, estorno, conta a definir), `entity.page`/`entity.child`, `caixa.page`/`accountsTab`/`statementTab`/`membersTab`, `category.page`, `transfer.page`, as novas seções `shell` (menu, trilha, busca, tema, "Fechar (Esc)", página não encontrada) e `overview`, e na paleta `filter`/`searching`/`dialogLabel`/as teclas. Nas áreas: `statements` (`changeFile`, `balanceOn`, `invoiceDue`, `mappingNameRequired`, `parsedLines`/`parsedErrors`/`parsedErrorRow`, `newRuleIn`, `copyRulesFor`), `contracts.numberShort` ("nº …", também na lista), `notes.monthOfYear` (título e `aria-label` do calendário), `agentsUi.recipes.unknownVariables` ("A receita não é salva com elas", já que a do agente fala do agente) e `agentsUi.recipes.sample` (os valores do lote de exemplo). "Escolha…" virou `t.common.choose` em todo o web (inclusive `forms.tsx` e `CaixaFormModal.tsx`), "Nada encontrado." o `t.common.noResults`, "Minha conta" e "Sair" o `t.nav.account` e o `t.auth.logout`, "Total" da pizza o `t.common.total`, "PDF" o `documents.formats.pdf`. Os grupos da paleta (`'Criar'`, `'Ir para'`…) continuam como chaves do registro de comandos (`CommandGroup`); o título exibido vem de `t.palette.group*` (`GROUP_LABEL` em `CommandPalette.tsx`).

Datas: `AgentWindows.tsx` mostra `formatDate(localDateOf(archivedAt))` (a data em SP, a mesma da lista "Sessões anteriores"); `ContractPage.tsx` usa `localDateOf(lastEditedAt)` no lugar do `slice(0, 10)` (só essa troca e as de texto, como pedido, por causa da tarefa 182); `EntrySources.tsx` usa `localDateOf(issuedAt)` na competência e na data exibida da NF-e. `localDateOf` devolve igual uma data sem hora ('YYYY-MM-DD', o `dEmi` da NF-e antiga), que antes viraria o dia anterior pela meia-noite UTC. Helpers novos em `packages/shared/src/dates.ts`: `instantFromSpLocal('YYYY-MM-DDTHH:MM')` (horário de parede de SP → instante UTC, com a segunda passada para as trocas de fuso antigas) e `spLocalOf(instante)`; o `PricesTab` grava a vigência do preço por `instantFromSpLocal`, e o hint diz "Horário de Brasília".

Complemento (lote seguinte da mesma frente): faltavam a `EntitiesPage` ("Nenhuma entidade cadastrada.", o cabeçalho "Caixas", o placeholder e o `aria-label` da busca e o subtítulo da página), agora em `t.entity.list`, e o `aria-label="Anexos"` do clipe na `PurchasesTab`, agora `t.attachments.title`; os textos continuam os mesmos.

Decisões: o item 5 (regra de `rg` no `verify:quick`) ficou de fora, por ser opcional e acusar falso positivo em `className` e chaves de comando. Ficaram fora desta tarefa os literais de arquivos não listados (a varredura foi nos arquivos afetados da tarefa).

Testes: `packages/shared/test/money-dates.test.ts` → "a sessão finalizada às 23h30 de SP é do mesmo dia no cabeçalho (tarefa 180)" (02:30 UTC do dia seguinte), "o datetime-local é horário de São Paulo, não o do navegador (tarefa 180)" (23:30 de SP, o horário de verão de 2018, datas e horas inválidas, ida e volta) e os casos novos do `localDateOf` (data sem hora e o `dhEmi` cru); conferido também com `TZ=UTC` e `TZ=Asia/Tokyo`. Os textos não mudam: os e2e existentes cobrem a regressão. Verificação: `pnpm verify:quick`.
