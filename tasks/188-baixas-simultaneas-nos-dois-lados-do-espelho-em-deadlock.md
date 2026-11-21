---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
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

## Resolução (executor)
