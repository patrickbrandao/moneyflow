---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 5384fd8
---

# Baixas simultâneas nos dois lados do espelho entram em deadlock e voltam como erro 500

- **Severidade:** baixa
- **Confiança:** provável (ordem das travas confirmada na leitura; não reproduzido)
- **Categoria:** bug
- **Subcategoria:** ordem de travas
- **Arquivos afetados:** `apps/server/src/services/settlements.ts:86,104`, `apps/server/src/errors.ts` (códigos traduzidos)
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se duas pessoas baixam ao mesmo tempo o mesmo título, uma pela caixa que paga e outra pela caixa que recebe (o espelho), o banco cancela uma das duas operações e ela vê "Algo deu errado", sem explicação.

### Evidência e análise técnica
`settleInTx` trava primeiro o título pedido e depois o espelho:

```ts
const title = await lockTitle(tx, titleId);                                        // settlements.ts:86
…
const mirror = title.mirrorTitleId ? await lockTitle(tx, title.mirrorTitleId) : null; // settlements.ts:104
```

Uma baixa pelo lado A trava A e espera B; a baixa simultânea pelo lado B trava B e espera A. O Postgres detecta o ciclo e aborta uma delas com `40P01` (deadlock_detected). O `translateDbError` traduz 23514, 23505, 23503 e 42501, não o 40P01, então a resposta é 500 com a mensagem genérica.

O mesmo padrão (próprio e depois o espelho) aparece em outros caminhos que tocam o par; vale conferir `updateTitle`/`syncMirror` em `titles.ts` e a baixa a partir da linha do extrato (`line-settle.ts`) ao corrigir.

### Verificação (tentativa de refutação)
- O banco serializa duas baixas no MESMO título (`settlements_validate` trava o título com `FOR UPDATE`), mas isso não ordena as travas do par.
- Não há advisory lock por par de títulos nem ordenação por id antes de travar.
- A janela é curta (milissegundos) e exige duas pessoas, ou uma pessoa e a conciliação automática, agindo nos dois lados ao mesmo tempo. Por isso a severidade é baixa.

### Impacto
Uma das duas baixas falha com 500 e precisa ser refeita. Nada fica inconsistente: a transação abortada é desfeita.

## Como reproduzir
Título com espelho (caixas A e B, um usuário com escrita em cada). Dois `POST /api/titles/:id/settlements` simultâneos, um com o id do lado A e outro com o do lado B (`Promise.all`), repetidos algumas vezes: uma das respostas sai 500 e o log mostra `deadlock detected`.

## Solução proposta
1. Em `settleInTx`, travar os dois títulos do par numa ordem fixa: `SELECT … FROM titles WHERE id IN (a, b) ORDER BY id FOR UPDATE`, e só depois separar o próprio e o espelho.
2. Aplicar a mesma ordem nos outros caminhos que travam o par.
3. Opcional: traduzir `40P01` e `40001` em `errors.ts` para um 409 "Tente de novo" em pt-BR, como rede de segurança para qualquer outro ciclo.

## Critérios de aceite
- [ ] Vinte pares de baixas simultâneas (um de cada lado) terminam sem nenhum 500.

## Testes recomendados
`apps/server/test/titles.test.ts`: o cenário de "Como reproduzir" em laço curto, esperando só 201 ou o 422 de saldo já baixado.

## Limitações e suposições
Não reproduzido; a conclusão vem da ordem das chamadas. Apontado de passagem pela revisão do banco (parte 1) e conferido pela sessão principal.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado na leitura: `settleInTx` travava o título pedido e depois o espelho; `updateTitle` e o estorno (`loadLeg` da perna pedida e depois da outra) tinham o mesmo padrão. O teste novo de 20 pares simultâneos falha no código anterior.

## Resolução (executor)

- `apps/server/src/services/titles.ts`: `lockTitlePair(tx, id)` trava o título e o espelho com um só `SELECT … WHERE id IN (…) ORDER BY id FOR UPDATE`, qualquer que seja o lado pedido; usado no `updateTitle` (entrou no commit da 075) e no `settleInTx`.
- `apps/server/src/services/settlements.ts`: `settleInTx` usa `lockTitlePair` (vale para a baixa pela tela, pela conciliação, pela linha do extrato e pelo pagamento da fatura); o estorno trava as duas pernas da mesma forma (`loadLegPair`).
- `apps/server/src/errors.ts` e `packages/shared/src/i18n/errors.ts`: rede de segurança — `40P01` (deadlock) e `40001` (serialização) viram 409 "Outra operação mexia nos mesmos registros ao mesmo tempo. Tente de novo."
- Teste: `apps/server/test/titles.test.ts`, "baixas simultâneas nos dois lados do espelho não se travam (tarefa 188)" — 20 pares de baixas simultâneas (metade de cada lado), todas 200 e o título pago.
- Verificação: `pnpm verify:quick` (nível rápido).
