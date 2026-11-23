---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Resposta de um filtro ou arquivo anterior sobrescreve a atual em cinco telas

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** corrida de requisições assíncronas (resposta fora de ordem, sem cancelamento)
- **Arquivos afetados:** `apps/web/src/components/messages/HistoryTab.tsx:32-48,58-64,188`, `apps/web/src/pages/AuditPage.tsx:45-70,239`, `apps/web/src/components/admin-ai/RequestsTab.tsx:41-71,153-155`, `apps/web/src/components/reconciliation/ImportModal.tsx:154-171,185-199,503-508,589-617`
- **Depende de / relacionado a:** tarefa 117 (o `useApi` de `apps/web/src/lib/hooks.ts:26-40` só ignora resposta de caminho diferente, não a recarga mais antiga do mesmo caminho; área da casca)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Em cinco lugares a tela pode mostrar o resultado de um pedido antigo depois do novo. Na auditoria e no histórico de mensagens, se você troca um filtro enquanto a lista anterior ainda está carregando, a lista que fica na tela pode ser a do filtro anterior, com os seletores mostrando o novo. Na lista de requisições da IA o mesmo acontece. Ao trocar rápido o arquivo do extrato, o resumo exibido pode ser do primeiro arquivo enquanto o importado é o segundo. E, depois de salvar um mapeamento de CSV e o import falhar, o formulário troca sozinho para outro mapeamento. A divergência não se corrige sozinha.

### Evidência e análise técnica
É o mesmo padrão em todos os lugares: o resultado de uma chamada assíncrona é aplicado sem conferir se ainda é o da última escolha do usuário (sem `cancelled`, contador de geração nem `AbortController`).

**1. Histórico de envios (`HistoryTab.tsx`) e log de auditoria (`AuditPage.tsx`).** As duas telas paginam com `load(before)` próprio, fora do `useApi`, e não descartam respostas antigas:

```ts
// HistoryTab.tsx:32-48 (AuditPage.tsx:49-70 é igual)
const load = useCallback(async (before) => {
  const page = await api.get('/api/message-outbox', { destinationId, status, before, limit: PAGE });
  setRows((current) => (before && current ? [...current, ...page] : page));
  setDone(page.length < PAGE);
}, [destinationId, status]);
useEffect(() => { setRows(null); void load(null); }, [load]);
```

- O filtro A dispara `load(null)`. O usuário troca para B, o efeito zera a lista e dispara `load(null)` de B. B responde primeiro (`rows = B`). Quando A responde, `setRows(pageA)` substitui a lista inteira, porque `before` é nulo, e `setDone` passa a refletir A. Os seletores mostram B, e a tabela mostra A.
- "Carregar mais" tem a mesma corrida: o clique pede `before = último id` do filtro A. Se o filtro mudar antes da resposta, as linhas de A são **anexadas** à lista de B (`[...current, ...page]`). Em `HistoryTab:188` o botão nem fica desabilitado durante a carga.
- Na auditoria a latência varia muito entre filtros (sem filtro é uma varredura; por tabela ou registro, a busca é por índice), então a resposta lenta chegar por último é o caso comum ao refinar o filtro.

**2. Requisições da IA (`RequestsTab.tsx:41-71`).** `useRequestPages` dispara `load(null)` a cada mudança de filtro, sem geração nem `AbortController`; quem responder por último vence (`setItems(page.items)`, `:53`). O filtro "Modelo" é texto livre sem debounce (`:153-155`): cada tecla é uma consulta, e as respostas podem chegar fora de ordem. "Carregar mais" (`:70`) com o cursor antigo, se a lista foi refeita no meio, anexa a página de outro filtro.

**3. Arquivo do import (`ImportModal.tsx:154-171`).** `pick` troca `file` na hora e espera `inspect` + `arrayBuffer`. Escolhendo o arquivo A e logo o B, se a inspeção de A terminar depois, ficam `file = B` com `inspect`/`buffer` de A: o resumo (período, quantidade, saldo do OFX), a escolha de conta do OFX (`ofxStatement`, `:196`) e o mapeamento do CSV montado sobre o conteúdo de A, e o upload é de B (`:190`).

**4. Mapeamento do CSV (`ImportModal.tsx:503-508`).** O efeito em `[mappings.data]` carrega o mapeamento padrão (ou o primeiro) **sempre** que a lista muda. Depois de salvar (`:604`, `mappings.reload()`) ou excluir (`:616`), a lista recarrega e o formulário troca para o padrão. Se o import falhar (ex.: `statement_duplicated`, comum ao reenviar o mesmo arquivo), o usuário passa a ver outro mapeamento; um novo "Salvar e importar" faz `PATCH` nesse outro (`:592-593`).

### Verificação (tentativa de refutação)
- Não há `cancelled`, contador de geração nem `AbortController` nas funções acima. A `CommandPalette` (`CommandPalette.tsx:33-52`) e o `EntityPicker` (`forms.tsx:91-116`) usam `cancelled`; onde já há proteção também estão `PreviousSessions.tsx:30-55` (geração), `AgentsMenu.tsx:48-62` (`alive`) e o `usePreview` dos contratos (`cancelled`). Os casos acima não têm.
- Nenhum teste cobre a troca rápida de filtro. Não há teste unitário no `apps/web`.
- No caso 4, com o import bem-sucedido o modal fecha (`StatementImportPanel.tsx:398-400`), então o efeito só aparece quando o import falha ou após excluir.

### Impacto
O admin pode tirar conclusões erradas do log de auditoria ("ninguém mexeu nesta tabela") ou reenviar e cancelar mensagens olhando a lista de outro destino; ler requisições de outro filtro sem perceber; importar um arquivo com o resumo de outro; editar o mapeamento de CSV errado. A chance de acontecer é baixa, mas o erro fica silencioso e leva a decisão errada.

## Como reproduzir
1. `/audit` sem filtros com "Slow 3G" no DevTools. Escolha logo uma tabela pouco usada no seletor. Quando a resposta sem filtro chega por último, a tabela mostra as linhas de todas as tabelas com o seletor numa só. (O histórico de envios tem o mesmo comportamento.)
2. /admin/ai/requests, digitar rápido no filtro "Modelo" com a rede lenta (DevTools → Slow 3G): a tabela termina com o resultado de um prefixo.
3. Importar extrato: escolher um OFX grande e, antes do resumo, trocar por um CSV pequeno: aparece o resumo do OFX com o nome do CSV.
4. Conta com dois mapeamentos (um padrão); escolher o outro, mudar o separador, "Salvar e importar" com um arquivo já importado (todas as linhas duplicadas): o formulário volta para o padrão.

## Solução proposta
1. `HistoryTab` e `AuditPage`: um `useRef` com a geração: `const gen = useRef(0)`. No efeito, `gen.current += 1`. Em `load`, guarde `const mine = gen.current` antes do `await` e descarte a resposta se `mine !== gen.current`. A mesma geração amarra "Carregar mais" ao filtro. Desabilite "Carregar mais" durante a carga no `HistoryTab`, como já faz a `AuditPage`.
2. `useRequestPages`: contador de geração (ou `AbortController`) e ignorar respostas antigas; debounce de 300 ms no filtro "Modelo" (`useDebounced`, como nas outras buscas).
3. `pick`: `const id = ++pickSeq.current` e só aplicar o resultado se `id === pickSeq.current`.
4. `CsvMapper`: carregar o padrão só na primeira chegada da lista (`useRef(false)`), não a cada recarga.
5. Opcional: extrair um `useCursorList(path, query)` comum às telas de lista com cursor (`HistoryTab`, `AuditPage`, `RequestsTab` e `NotesBrowser`, que têm o mesmo formato).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/components/messages/HistoryTab.tsx
+++ b/apps/web/src/components/messages/HistoryTab.tsx
@@
+  const gen = useRef(0);
   const load = useCallback(
     async (before: string | null) => {
+      const mine = gen.current;
       try {
         const page = await api.get<OutboxMessageDto[]>(...);
+        if (mine !== gen.current) return;
         setRows((current) => (before && current ? [...current, ...page] : page));
@@
   useEffect(() => {
+    gen.current += 1;
     setRows(null);
     void load(null);
   }, [load]);
```

## Critérios de aceite
- [ ] Com a primeira resposta atrasada de propósito, a tabela do histórico e da auditoria sempre corresponde aos filtros visíveis.
- [ ] "Carregar mais" seguido de troca de filtro não mistura linhas de filtros diferentes.
- [ ] A tabela de requisições sempre corresponde ao filtro mostrado.
- [ ] O resumo do import é sempre do arquivo selecionado.
- [ ] Salvar ou excluir um mapeamento não troca o formulário sozinho.

## Testes recomendados
- e2e (`agentes.spec.ts` já sobe a pilha; ou um `auditoria.spec.ts` novo): `page.route('**/api/audit?*', …)` atrasando só a primeira chamada, trocar o seletor de tabela e conferir que todas as linhas exibidas são da tabela escolhida.
- `e2e/tests/agentes.spec.ts` (bloco das requisições ao provedor): `page.route` atrasando a primeira resposta de `/api/admin/ai/requests` e digitando no filtro; esperar só as linhas do filtro final.
- Um caso de import em `e2e/tests/operacao.spec.ts` com `page.route` atrasando `/api/statements/inspect` do primeiro arquivo.

## Limitações e suposições
Nada foi executado. A diferença de latência entre os filtros da auditoria foi inferida do formato da consulta, sem medir.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado nos cinco pontos: `HistoryTab` e `AuditPage` (`load(before)` sem geração), `useRequestPages` (sem geração e o filtro "Modelo" sem debounce), o `pick` do `ImportModal` e o `CsvMapper`, que recarregava o mapeamento padrão a cada recarga da lista.

## Resolução (executor)
`HistoryTab` e `AuditPage`: um contador por carga (`seq`); só a última pedida aplica as linhas, o "acabou" e o erro, então a resposta lenta de um filtro anterior e o "Carregar mais" pedido antes da troca são descartados; o "Carregar mais" do histórico desliga durante a carga, como na auditoria. `useRequestPages` (`RequestsTab.tsx`): o mesmo contador, e o filtro "Modelo" espera 300 ms (`useDebounced`). `ImportModal`: `pick` numera a escolha e só aplica a inspeção e o conteúdo do último arquivo (e zera o conteúdo do anterior). `CsvMapper`: carrega o mapeamento padrão só na primeira chegada da lista; salvar ou excluir não troca o formulário. O `useApi` (tarefa 117) também passou a descartar a recarga mais antiga do mesmo caminho. O `useCursorList` comum (item 5, opcional) ficou de fora para não reorganizar as quatro telas.

Testes: e2e novo em `e2e/tests/respostas.spec.ts` → "auditoria: a resposta lenta sem filtro não substitui a do filtro escolhido" (a primeira chamada atrasada com `page.route`; não rodado aqui). Verificação: `pnpm verify:quick`.
