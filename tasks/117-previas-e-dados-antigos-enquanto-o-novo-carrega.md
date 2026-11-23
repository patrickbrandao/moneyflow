---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: d6f991c
---

# Telas mostram e aplicam a prévia ou os dados do filtro anterior enquanto o novo carrega

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** estado velho sem indicação (stale-while-loading) e prévia desatualizada habilitando a confirmação
- **Arquivos afetados:** `apps/web/src/lib/hooks.ts:19-47`, `apps/web/src/components/titles/SeriesEndModal.tsx:25-30,87-93`, `apps/web/src/pages/FinancialAccountPage.tsx:43-44,132-133,161-167,209-220`, `apps/web/src/pages/ReportsPage.tsx:57-59,98-115`, `apps/web/src/components/reports/CategoryReport.tsx:210-213`, `apps/web/src/components/card/InvoiceModals.tsx:23-44,330,363-380`, `apps/web/src/components/caixa/AccountOverview.tsx:192-195,226-243`, `apps/web/src/pages/CalendarPage.tsx:69-70,96-106,169-194`, `apps/web/src/components/caixa/AccountsTab.tsx:312-321,444-469`, `apps/web/src/components/contracts/ContractActionModals.tsx:30-63,112-141,279,308-336,354-357,479,510-516,571`, `apps/web/src/components/contracts/ObligationFormModal.tsx:818-833,887-889`, `apps/server/src/services/contracts.ts:869-875`
- **Depende de / relacionado a:** tarefa 118
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao trocar a conta, o período, a data ou o valor de uma prévia, a tela continua mostrando os números da escolha anterior até a resposta nova chegar, sem nenhum "carregando". Nesse intervalo dá para confirmar uma ação ou exportar um relatório com os dados errados. Nas janelas de aditivo, rescisão e renovação do contrato, a prévia ("o que vai mudar") demora um instante para se atualizar depois que você troca a data ou o valor; o botão de aplicar continua ligado mostrando a prévia anterior, e apertar Enter no campo aplica o valor novo sem você ter visto o efeito dele. Na rescisão, a última parcela pode ficar com o proporcional calculado para a data antiga.

### Evidência e análise técnica
São **dois mecanismos do mesmo defeito**: a tela guarda o resultado de uma consulta de uma escolha anterior e o usa (ou deixa o usuário agir sobre ele) depois que a escolha mudou. Um está no hook genérico `useApi`; o outro, no `usePreview` próprio dos modais de contrato.

#### Mecanismo 1: `useApi` (`apps/web/src/lib/hooks.ts:19-47`)
`useApi` não zera `data` quando o `path` muda. A guarda `latest.current === path` só impede que a resposta de um caminho antigo seja pintada; o valor do caminho anterior fica em `data` até a nova resposta. O `loading` existe, mas quase nenhuma tela o lê (só `CalendarPage:290`, `SettlementModal:175` e o `TransferModal`), e todas testam `!data` para decidir o esqueleto. Casos com efeito real:

- **Prévia destrutiva desatualizada (Encerrar série).** `SeriesEndModal` pede a prévia por `?endsOn=` (`:28-30`). Ao trocar a data, `preview` continua com o resultado da data anterior e o botão "Aplicar" fica habilitado (`disabled={busy || !preview || blocked.length > 0}`, `:89`). O usuário vê "cancela 2 ocorrências", troca a data para antes e aplica. O POST usa a data nova, que pode cancelar 8. Se a prévia nova falhar, o erro aparece junto com a prévia velha, e o botão continua habilitado.
- **Números de outra conta.** Na tela da conta, o seletor troca de conta sem desmontar (`FinancialAccountPage:161-167`). O cabeçalho mostra a conta nova, mas as caixas "entradas/saídas do mês" (`:209-220`) leem `current.data` (`:44,132`), que ainda é da conta anterior. Não há esqueleto, porque `thisMonth` existe.
- **Exportação com o cabeçalho de um período e os dados de outro.** Em `ReportsPage`, o subtítulo do PDF/CSV sai da URL (`:98-101`) e a tabela sai de `categories.data` (`:106`). Exportar logo depois de mudar o período gera "01/05–31/10" no cabeçalho com os valores do período anterior. O nome do arquivo usa `data.from/to` (`CategoryReport:212`), o que agrava a divergência.
- **Conta pré-escolhida da pagadora errada.** `AccountSelect` (`InvoiceModals:38-44`) escolhe `list[0]` assim que há dados. Ao trocar a pagadora, a lista ainda é da anterior, e o efeito grava uma conta da pagadora antiga em `accountId`. Ela só é corrigida quando a nova lista chega.
- **Mesmo sintoma em leitura:** os gráficos do Resumo da conta ao trocar o período (`AccountOverview:226-243`) e as caixas de totais do calendário ao mudar de mês (`CalendarPage:96-106,169-194`).
- **Mecanismo parecido fora do `useApi`:** no lançamento avulso do cofre, a oferta "É o pagamento de…?" vem de uma chave com debounce (`AccountsTab:447`). Durante os 300 ms do debounce e o tempo da requisição, a oferta mostrada é a do valor anterior. Clicar em "Baixar a ocorrência" (`:345-360`) baixa com o `split` desse valor.
- **"Encerrar ou estender" a série na obrigação do contrato** (`ObligationFormModal.tsx:818-833`) usa `useApi` com a data no caminho; o `useApi` mantém o `data` do caminho anterior até o novo responder, então o botão (`:887-889`, inclusive a cor `danger` pela quantidade a cancelar) reflete a data anterior.

Detalhes menores do mesmo hook: duas recargas do mesmo caminho não têm número de sequência, então a mais lenta vence. Não há `AbortController`. Se o caminho passa a `null` com uma busca em andamento, `loading` fica `true` para sempre, porque o `finally` (`:38`) só limpa quando o caminho ainda é o mesmo.

#### Mecanismo 2: `usePreview` dos modais de contrato (`ContractActionModals.tsx:30-63`)
- `usePreview` espera 300 ms e pede o `dryRun`; ao mudar o corpo, **não limpa** `preview` (só troca quando a resposta chega). O botão de enviar fica habilitado por `!preview` (`:279`, `:479`, `:571`) e o `submit` manda o `body` atual (`:137-141`, `:354-357`, `:516`), não o que gerou a prévia.
- Os formulários são `<form onSubmit>` com botão `type="submit"`: Enter no campo de data dispara a submissão implícita na hora.
- **Rescisão** (`:308-336`): `lastAmounts` é preenchido com o proporcional sugerido **quando a prévia chega** (`:325-330`). Trocando a data de 10/03 para 25/03 (mesmo mês, mesma última ocorrência) e apertando Enter, o corpo sai com `terminatedOn = 25/03` e `lastAmounts` = proporcional de 10/03. O servidor aplica o valor porque o título ainda é a última ocorrência do plano novo (`contracts.ts:871-875`: só ignora quando o título não está em `plan.last`, quando já está pago ou quando o valor é igual ao cheio).
- **Aditivo** (`:112-141`): trocar 1.000 → 1.100 e apertar Enter aplica 1.100 em "esta e as próximas" com a lista de 1.000 na tela; `changes === 0` também vem da prévia velha.
- **Renovação** (`:510-516,571`): mesmo `usePreview`, mesmo botão habilitado por `!preview`.
- O `SupersedeModal` (`components/reconciliation/SupersedePanel.tsx:60-72`) faz certo: `setPreview(null)` ao mudar a escolha, e o botão fica desligado até a prévia nova.

### Verificação (tentativa de refutação)
- O comentário de `hooks.ts:18` ("sem pintar a resposta antiga") descreve a guarda de corrida, não a limpeza: o `setData` do caminho anterior nunca é desfeito.
- A rota `caixas/:id/accounts/:accountId` reaproveita o mesmo componente ao trocar de conta (mesmo elemento na mesma posição). Não há `key` por conta em `FinancialAccountPage`, só nos filhos (`:261-267`).
- O servidor revalida e recalcula o plano na transação (`contracts.ts:869`; e revalida a série no POST), então nada fica inconsistente no banco e o cancelamento das ocorrências segue a data nova. O problema é a decisão do usuário, tomada sobre uma prévia que não corresponde ao pedido, e o `lastAmounts` herdado, que o servidor aceita.
- O `apps/web` não tem testes unitários, e o e2e não atrasa respostas. Não há teste e2e da rescisão nem de mudar um campo e enviar antes da prévia: `e2e/tests/contratos.spec.ts:128` só confere a prévia da renovação.

### Impacto
Em rede lenta ou com um servidor ocupado, qualquer pessoa que troque um filtro, uma data ou um valor e aja logo depois (ou aperte Enter). O pior caso é a prévia do "Encerrar série" e da rescisão, que existem justamente para mostrar o que será cancelado: a rescisão (operação destrutiva, sem desfazer simples) pode sair com o proporcional errado na última ocorrência, e o aditivo pode ser aplicado em várias ocorrências com um valor cuja prévia não foi mostrada. Também há números de outra conta sob o nome da nova, relatórios exportados com período e dados divergentes e conta da pagadora errada pré-escolhida.

## Como reproduzir
1. No DevTools, ative "Slow 3G".
2. Abra um título recorrente → Encerrar série. A prévia mostra N canceladas. Troque a data para meses antes e clique em Aplicar antes de a prévia mudar. A operação cancela mais ocorrências do que a prévia mostrava.
3. Na tela da conta, troque a conta pelo seletor. Durante o carregamento, as caixas de entradas e saídas mostram os valores da conta anterior sob o nome da nova.
4. Rescisão: contrato vigente com obrigação mensal; abrir "Rescindir". Esperar a prévia de uma data (ex.: dia 10 do mês corrente) e ver o proporcional sugerido da última ocorrência. Trocar a data para o dia 25 do mesmo mês e apertar Enter imediatamente. A última ocorrência fica com o proporcional do dia 10.

## Solução proposta
**`useApi`:**
1. Guarde junto com o dado o caminho de onde ele veio (`{ path, value }`). Devolva `data` só quando `dataPath === path`, ou devolva `data` e `stale: dataPath !== path` e deixe cada tela escolher.
2. Acrescente um contador de requisição (descarta resposta de geração antiga, inclusive no mesmo caminho) e um `AbortController` no efeito. Zere `loading` quando o caminho for `null`.
3. Nas ações que dependem do dado, desabilite enquanto `stale || loading`: "Aplicar" do `SeriesEndModal`, `ExportMenu` dos relatórios e `AccountSelect`, que só escolhe a conta padrão quando a lista é da pagadora atual.
4. No `AdjustmentModal`, guarde em `useObligationMatches` a chave da resposta e ofereça a baixa só quando ela for igual à chave atual, sem debounce.

**`usePreview` dos contratos:**
5. `usePreview` devolve também a chave do corpo que gerou a prévia (`previewKey`); o botão só liga com `previewKey === key`, e o efeito zera `preview` (ou marca "atualizando") no início de cada mudança.
6. Na rescisão, montar `lastAmounts` só quando `previewKey === key`, e zerar `lastAmounts` ao trocar `terminatedOn`.
7. No `SeriesRuleEndModal`, guardar a data da prévia recebida (ou usar o `SeriesEndPreview` só quando corresponder a `target`) e desligar o botão enquanto difere.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/lib/hooks.ts
+++ b/apps/web/src/lib/hooks.ts
@@
-  const [data, setData] = useState<T | undefined>(undefined);
+  const [state, setState] = useState<{ path: string | null; value: T | undefined }>({ path: null, value: undefined });
+  const seq = useRef(0);
@@
-      const value = await api.get<T>(path);
-      if (latest.current === path) {
-        setData(value);
+      const mine = ++seq.current;
+      const value = await api.get<T>(path);
+      if (mine === seq.current) {
+        setState({ path, value });
@@
-  return { data, error, loading, reload: load, setData: ... };
+  const stale = state.path !== path;
+  return { data: stale ? undefined : state.value, stale, error, loading, reload: load, setData: ... };
```
(Devolver `undefined` enquanto troca reacende os esqueletos. Se alguma tela preferir manter o dado antigo esmaecido, ela usa `stale`.)

```diff
--- a/apps/web/src/components/contracts/ContractActionModals.tsx
+++ b/apps/web/src/components/contracts/ContractActionModals.tsx
 function usePreview<P>(path: string, body: unknown, enabled: boolean) {
-  const [preview, setPreview] = useState<P | null>(null);
+  const [state, setState] = useState<{ key: string; preview: P } | null>(null);
   const [error, setError] = useState<string | null>(null);
   const key = JSON.stringify(body);
@@
-          if (!cancelled) {
-            setPreview(result.preview);
+          if (!cancelled) {
+            setState({ key, preview: result.preview });
@@
-  return { preview, error };
+  const fresh = state?.key === key ? state.preview : null;
+  return { preview: fresh, stale: state && state.key !== key ? state.preview : null, error };
 }
```

## Critérios de aceite
- [ ] Trocar a data no "Encerrar série" desabilita "Aplicar" até a prévia da data nova chegar.
- [ ] Trocar de conta na tela da conta mostra esqueleto nas caixas do mês, nunca os números da conta anterior.
- [ ] Exportar um relatório durante o carregamento de um filtro novo fica desabilitado.
- [ ] Duas recargas seguidas do mesmo caminho: vale a última pedida, não a última respondida.
- [ ] Depois de mudar qualquer campo nos modais de aditivo, rescisão e renovação, o botão de aplicar fica desligado até a prévia daquele corpo chegar; Enter não aplica antes disso.
- [ ] Na rescisão, o `lastAmounts` enviado é sempre o sugerido (ou editado) para a data enviada.
- [ ] O "Encerrar ou estender" da obrigação não mostra a contagem da data anterior como se fosse a nova.

## Testes recomendados
- `apps/web` não tem testes unitários. Propor vitest + jsdom + Testing Library só para `lib/hooks.ts`: trocar o `path` com a primeira resposta pendente; resolver fora de ordem; caminho virando `null` com a busca em andamento.
- e2e (`contratos.spec.ts` ou novo): `page.route('**/series/end*', r => setTimeout(() => r.continue(), 1500))`, trocar a data e conferir que o botão "Aplicar" fica desabilitado.
- `e2e/tests/contratos.spec.ts`: com `page.route` atrasando a resposta do `?dryRun=1` em 1 s, abrir a rescisão, trocar a data e apertar Enter; esperar o botão desligado e nenhuma chamada sem `dryRun`. Depois liberar e conferir que o valor da última ocorrência é o proporcional da data nova.

## Limitações e suposições
Nada foi executado. O efeito com rede lenta foi deduzido do código; a janela do problema nos modais de contrato é de 300 ms mais a latência do `dryRun`. Não conferi se o servidor rejeita uma conta de outra pagadora no adiantamento da fatura; pela regra das contas por caixa, provavelmente rejeita.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `useApi` mantinha o `data` do caminho anterior até a resposta nova; o `usePreview` dos modais de contrato não limpava a prévia ao mudar o corpo e o botão ligava por `!preview`; `useObligationMatches` (cofre) mostrava a oferta do valor anterior durante o debounce. O `AccountSelect` da fatura escolhia a conta da lista da pagadora anterior.

## Resolução (executor)
`useApi` (`apps/web/src/lib/hooks.ts`) guarda o dado junto com o caminho de onde veio: com o caminho trocado, `data` (e `error`) voltam a `undefined` até a resposta nova, e `loading` fica verdadeiro também enquanto o dado não é do caminho atual (e falso com o caminho nulo). Cada busca tem um número e a anterior é abortada (`AbortController`, `api.get` aceita `signal`): vale a última pedida, mesmo no mesmo caminho. Opção `keepPrevious` mantém o dado anterior com `stale: true`; usada só no canvas (`FlowPage`/`MoneyFlowCanvas`, esmaecido, para não perder o enquadramento) e nas listas ao "Carregar mais" (tarefa 116). Com isso: o "Aplicar" do `SeriesEndModal` e do `SeriesRuleEndModal` desliga até a prévia da data nova (com "Carregando…"); as caixas do mês da tela da conta mostram esqueleto ao trocar de conta; a exportação dos relatórios fica desligada enquanto o filtro novo carrega; o `AccountSelect` só escolhe a conta padrão com a lista da pagadora atual; os gráficos do Resumo e os totais do calendário mostram esqueleto/"—".

`usePreview` (`ContractActionModals.tsx`) guarda o corpo que gerou a prévia e só a devolve enquanto ele for o da tela: mudado um campo, o botão de aditivo, rescisão e renovação desliga, e o Enter não aplica (a submissão implícita respeita o botão desligado; o `submit` também confere a prévia). Na rescisão, o proporcional sugerido (`lastAmounts`) é refeito a partir da prévia da data enviada. `useObligationMatches` (`AccountsTab.tsx`) guarda a chave da resposta e só oferece a baixa quando ela é a do valor, entidade e data na tela.

Testes: o web não tem unitários; o hook se apoia no typecheck e no e2e novo `e2e/tests/respostas.spec.ts` → "Encerrar série: trocada a data, "Aplicar" espera a prévia nova" (resposta atrasada com `page.route`; não rodado aqui). Verificação: `pnpm verify:quick`.
