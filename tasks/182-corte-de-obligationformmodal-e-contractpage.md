---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 520d60e
---

# Cortar `ObligationFormModal.tsx` (898 linhas) e `ContractPage.tsx` (831) e unificar o diff de versões

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** DX
- **Subcategoria:** arquivo grande demais e duplicação
- **Arquivos afetados:** `apps/web/src/components/contracts/ObligationFormModal.tsx:1-898`, `apps/web/src/pages/ContractPage.tsx:1-831`, `apps/web/src/components/contracts/ContractActionModals.tsx:24,26`, `apps/web/src/components/contracts/ContractFormModal.tsx:31`, `apps/web/src/components/titles/TitleDrawer.tsx:29`, `apps/web/src/components/contracts/DocumentView.tsx:199-317`, `apps/web/src/components/admin-ai/AgentPrompt.tsx:53-189`, `apps/web/src/components/account/ApiTokensPanel.tsx:122-193`, `apps/web/src/pages/AdminMcpPage.tsx:187-293`
- **Depende de / relacionado a:** tarefa 181
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Dois arquivos das telas de contrato juntam coisas demais e partes de outras telas (a série do título usa um modal que mora no arquivo da obrigação do contrato). Isso não muda nada para quem usa hoje, mas deixa cada mudança mais lenta e mais arriscada.

### Evidência e análise técnica
**`ObligationFormModal.tsx` (898 linhas, 7 assuntos):**
- `:43-175` ajustes de reconhecimento (draft, conversão, resumo e `TermsFields`);
- `:177-248` opções de conta/cartão/pagadora (`useObligationOptions`, `AccountSelect`);
- `:250-542` obrigação nova (draft, validação, corpo da API, `ObligationFields`, `ObligationsEditor`);
- `:544-594` `ObligationFormModal`;
- `:596-741` `SeriesEditModal` (também da gaveta do título: `TitleDrawer.tsx:29,547`);
- `:743-802` `LinkSeriesModal`;
- `:804-898` `SeriesRuleEndModal` (usa só `t.title.*`, é da série, não do contrato).
`ContractActionModals.tsx:24` importa `AccountSelect`, `calendarText` e `useObligationOptions` daqui, e `kindOf` está repetido em `ObligationFormModal.tsx:41`, `ContractActionModals.tsx:26` e `ContractFormModal.tsx:31`.

**`ContractPage.tsx` (831 linhas):** a página (`:75-277`) e mais seis componentes: `Totals` (`:279-313`), `Summary` (`:315-361`), `placeOf` + `Obligations` com os títulos avulsos (`:363-540`), `Documents` (`:542-641`), `changeValue` + `ContractHistory` (`:643-758`) e `NewMarkdownModal` (`:760-831`).

**Duplicação de "versões com diff":** `DocumentView.tsx:199-317` (`Versions` + `VersionDiff`) e `AgentPrompt.tsx:53-189` (`PromptHistory` + `PromptDiff`) têm a mesma lista com rádios A/B, o mesmo "restaurar" com confirmação e o mesmo HTML do diff (`DocumentView.tsx:304-312` × `AgentPrompt.tsx:176-184`).

**Duplicação de "chave criada":** `ApiTokensPanel.tsx:122-193` e `AdminMcpPage.tsx:187-293` repetem o modal de revelação do token e a validação de `expiresInDays` (1–3650).

### Verificação (tentativa de refutação)
- Os componentes internos não usam estado do arquivo pai; o corte é mecânico (mover e importar).
- Nenhum teste importa caminhos internos desses arquivos (os e2e usam `data-testid`).

### Impacto
Custo de manutenção: cada mudança em séries mexe num arquivo de contrato de 900 linhas; o diff e o modal de token evoluem em dois lugares (o que já gerou a divergência dos ajustes, ver a tarefa relacionada).

## Como reproduzir
Cenário do custo: para mudar o "Encerrar ou estender" da série (usado pelo título), hoje é preciso abrir `components/contracts/ObligationFormModal.tsx`; para mudar o visual do diff, dois arquivos.

## Solução proposta
1. Criar `components/series/`: `SeriesEditModal.tsx`, `SeriesRuleEndModal.tsx`, `SeriesTermsFields.tsx` (o único editor de ajustes, ver a tarefa relacionada), `series-text.ts` (`calendarText`, `termsSummary`, `kindOf`).
2. `components/contracts/`: `obligation-options.ts(x)` (`useObligationOptions`, `AccountSelect`), `ObligationFields.tsx` (draft, validação, campos, editor e o `ObligationFormModal`) e `LinkSeriesModal.tsx`. `ObligationFormModal.tsx` deixa de existir ou vira só o modal.
3. `ContractPage.tsx` → `ContractSummary.tsx` (`Totals` + `Summary`), `ContractObligations.tsx` (`Obligations`, `placeOf`, títulos avulsos), `ContractDocuments.tsx` (`Documents` + `NewMarkdownModal`), `ContractHistory.tsx`; a página fica com ~250 linhas.
4. `components/diff/LineDiff.tsx` (as linhas do diff com as estatísticas) e `VersionCompare.tsx` (lista com A/B, ver uma, restaurar por callback), usados por `DocumentView` e `AgentPrompt`.
5. `components/account/TokenReveal.tsx` (modal de revelação + `expiresInDaysError`), usado por `ApiTokensPanel` e `AdminMcpPage`.

## Critérios de aceite
- [ ] Nenhum arquivo das telas de contrato acima de ~400 linhas.
- [ ] `TitleDrawer` e `ContractPage` importam a série de `components/series/`.
- [ ] Diff de versões e modal de token num lugar só.
- [ ] `pnpm verify:quick` e o e2e de contratos e agentes passam sem mudar os `data-testid`.

## Testes recomendados
Sem teste novo: os e2e existentes (`e2e/tests/contratos.spec.ts`, `contratos-pagamentos.spec.ts`, `agentes.spec.ts` no histórico do prompt) cobrem o comportamento; rodá-los antes e depois.

## Limitações e suposições
Proposta de corte, sem medir tempo de build ou de revisão.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `ObligationFormModal.tsx` com 902 linhas e sete assuntos (o `SeriesEditModal` da gaveta do título e o `SeriesRuleEndModal` dentro do arquivo do contrato), `ContractPage.tsx` com 832 linhas e seis componentes, `kindOf` repetido em quatro arquivos (também no `TitleFormModal`), o diff de versões duplicado em `DocumentView` e `AgentPrompt` e o modal da chave criada e a validade em dias duplicados em `ApiTokensPanel` e `AdminMcpPage`.

## Resolução (executor)

Corte mecânico (sem mudar os `data-testid`), junto com a tarefa 181:

- `components/series/`: `SeriesEditModal.tsx`, `SeriesRuleEndModal.tsx`, `SeriesTermsFields.tsx` (o editor único da 181) e `series-text.ts` (`kindOf`, `calendarText`; o `kindOf` repetido saiu de `ContractActionModals`, `ContractFormModal` e `TitleFormModal`). O resumo dos ajustes fica no shared (`seriesTermsSummary`). `TitleDrawer` e `ContractPage` importam a série daqui.
- `components/contracts/`: `obligation-options.tsx` (`useObligationOptions`, `AccountSelect`), `ObligationFields.tsx` (rascunho, validação, corpo da API, campos e `ObligationsEditor`), `ObligationFormModal.tsx` (só o modal), `LinkSeriesModal.tsx`; o aditivo saiu de `ContractActionModals.tsx` para `AmendmentModal.tsx` e o `usePreview` para `contract-preview.ts`.
- `ContractPage.tsx` (242 linhas) → `ContractSummary.tsx` (`ContractTotals`, `ContractSummary`), `ContractObligations.tsx` (com os títulos avulsos), `ContractDocuments.tsx` (com o `NewMarkdownModal`) e `ContractHistory.tsx`.
- `components/diff/LineDiff.tsx` (o diff com as contagens) e `VersionCompare.tsx` (lista com A/B, ver uma, voltar a comparar e restaurar por callback), usados por `DocumentView` e `AgentPrompt`. Unificado também o comportamento: sem escolha, A é a penúltima e B a última (como já era no documento); clicar na versão aberta volta à comparação; os rádios têm o rótulo "A: versão N"/"B: versão N" (chaves novas `t.contracts.documents.compareA`/`compareB` no lugar do literal `A v…` e do `compareWith`).
- `components/account/TokenReveal.tsx`: `TokenRevealModal` (a chave mostrada uma vez, com o comando do Claude por `children` no Controle MCP), `ExpiresInDaysField` e `expiresInDaysOf` (1–3650), usados por `ApiTokensPanel` e `AdminMcpPage`.

Pendente da tarefa 114, terminado aqui: as linhas dos títulos avulsos (`ContractObligations`) têm o nome como `RowLink` para o título e as dos documentos (`ContractDocuments`) o título como `RowButton`; o `role="radiogroup"` do `LinkSeriesModal` saiu do `<ul>` (vai num `<div>`, com as linhas em `<div className="item">`), e a regra `noNoninteractiveElementToInteractiveRole` foi religada como `error` no `biome.json` (o `pnpm lint` do projeto passa sem outro caso).

Tamanhos: nenhum arquivo das telas de contrato passa de 400 linhas, fora o `ContractFormModal.tsx` (472, um componente só, que a tarefa não pedia para cortar). `AGENTS.md` (item F20 da estrutura) atualizado com os caminhos novos.

Testes: sem teste novo de comportamento (o corte não muda nada para o usuário); cobrem os e2e existentes de contratos e do histórico do prompt (`agentes.spec.ts`), não rodados aqui. Verificação: `pnpm verify:quick`.
