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

# Saldo do banco do lote CSV sai errado quando o arquivo vem do mais recente para o mais antigo

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** saldo do lote e divergência
- **Arquivos afetados:** `apps/server/src/services/statements.ts:243-250`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o CSV tem a coluna de saldo, o sistema usa o saldo da "última" linha do último dia como o saldo do banco e já compara com o do app. Se o banco exporta o extrato do mais recente para o mais antigo (comum nas telas e exportações de banco), ele pega o saldo de um momento do meio do dia, e a tela acusa uma divergência que não existe.

### Evidência e análise técnica
`statements.ts:243-244`:
```ts
const withBalance = applied.lines.filter((l) => l.balanceCents !== null);
const last = withBalance.reduce((acc, l) => (!acc || l.postedOn >= acc.postedOn ? l : acc), null);
```
O empate na data máxima (`>=`) fica com a linha que aparece **depois no arquivo**. No arquivo crescente, é a última transação do dia (certo). No decrescente, é a **primeira** transação do dia, e o saldo dela é intermediário.

Script descartável (mesmo `applyCsvMapping` do shared e a mesma redução):
```
20/10/2026;TARIFA;-10,00;1.000,00        ← última do dia, saldo final
20/10/2026;PIX RECEBIDO;100,00;1.010,00
19/10/2026;MERCADO;-50,00;910,00
→ saldo escolhido 101000 em 2026-10-20 (o certo: 100000)
```
O valor vai direto para `statement_imports.bank_balance_cents` (`statements.ts:412-417, 431-432`) e para a divergência acumulada e a do intervalo (`importSql`, `statements.ts:866-901`), e o aviso `reconciliation_divergence` do sino e do Telegram parte dela.

### Verificação (tentativa de refutação)
- O teste do CSV (`apps/server/test/statements.test.ts:202-238`, fixture `extrato-itau.csv`) e o unitário (`packages/shared/test/csv.test.ts:75`) só usam arquivo crescente e um lançamento por dia no último dia.
- O usuário pode corrigir em "Editar saldo", mas o saldo errado já vem aplicado sem aviso (spec 009: "o campo vem vazio e é opcional" só sem saldo no arquivo; com saldo, é aplicado). "Voltar ao saldo do arquivo" relê o mesmo CSV e repete o erro (`setImportBankBalance`, `statements.ts:1093-1107`).
- O banco não confere o saldo do lote contra as linhas.

### Impacto
Toda conta cujo banco exporta CSV decrescente com saldo, sempre que o último dia tem mais de um lançamento: divergência falsa no lote, no intervalo do lote seguinte e nos avisos.

## Como reproduzir
Mapeamento CSV com a coluna de saldo; importar o arquivo do exemplo acima: o lote mostra saldo do banco R$ 1.010,00 e divergência de R$ 10,00 contra um app correto.

## Solução proposta
Escolher pela ordem do arquivo: se a primeira linha com data é posterior à última (arquivo decrescente), o saldo do dia mais recente é o da **primeira** linha desse dia; senão, o da última. Levar a regra para o shared (`csvBankBalance(lines)`) para ter teste unitário.

### Diff/patch proposto — NÃO APLICADO
```diff
-  const withBalance = applied.lines.filter((l) => l.balanceCents !== null);
-  const last = withBalance.reduce<(typeof withBalance)[number] | null>((acc, l) => (!acc || l.postedOn >= acc.postedOn ? l : acc), null);
+  const withBalance = applied.lines.filter((l) => l.balanceCents !== null);
+  // Arquivo do mais recente para o mais antigo: o saldo final do dia é o da primeira linha dele.
+  const descending = applied.lines.length > 1 && applied.lines[0]!.postedOn > applied.lines.at(-1)!.postedOn;
+  const last = withBalance.reduce<(typeof withBalance)[number] | null>(
+    (acc, l) => (!acc || l.postedOn > acc.postedOn || (l.postedOn === acc.postedOn && !descending) ? l : acc),
+    null,
+  );
```

## Critérios de aceite
- [ ] CSV decrescente com dois lançamentos no último dia: saldo do banco = o da primeira linha do arquivo.
- [ ] CSV crescente continua com o saldo da última linha do último dia.

## Testes recomendados
`packages/shared/test/csv.test.ts` (se a função for para o shared) com os dois sentidos; `apps/server/test/statements.test.ts`, caso "importa CSV com mapeamento salvo por conta", com uma variante decrescente da fixture.

## Limitações e suposições
Só a redução foi executada, num script descartável (`<RASCUNHO>/scripts/csvbal.ts`). Não conferi (sem rede) quais bancos exportam em ordem decrescente; o defeito vale para qualquer um que exporte.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: a redução com `>=` ficava com a última linha do último dia na ordem do arquivo, que no arquivo decrescente é a primeira transação do dia (saldo intermediário). "Voltar ao saldo do arquivo" repetia o erro.

## Resolução (executor)

- `packages/shared/src/parsers/csv.ts`: `csvBankBalance(lines)`: o arquivo é decrescente quando a primeira linha tem data posterior à última; no dia mais recente, vale a primeira linha dele no decrescente e a última no crescente.
- `apps/server/src/services/statements.ts`: `parseStatementFile` usa `csvBankBalance` (vale para o import e para o "Voltar ao saldo do arquivo").
- Spec 009 (saldo do arquivo no CSV).
- Testes: `packages/shared/test/csv.test.ts` ("csvBankBalance": decrescente, crescente, um dia só e sem saldo); `apps/server/test/statements.test.ts`, "CSV em Latin-1 decrescente…": o lote fica com R$ 1.000,00 em 20/10 e o "Voltar ao saldo do arquivo" devolve o mesmo.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
