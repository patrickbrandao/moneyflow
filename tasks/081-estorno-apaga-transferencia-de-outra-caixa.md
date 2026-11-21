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

# Estorno com "desfazer transferência" apaga o movimento da conta de outra caixa sem escrita nela

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** `Access` incompleto no estorno
- **Arquivos afetados:** `apps/server/src/services/settlements.ts:215-264` (em especial `224` e `236-260`), `apps/server/src/services/settlements.ts:95-102` (contraste), `apps/server/src/services/transfers.ts:50-56,91-96` (contraste), `apps/server/src/agents/tool-handlers.ts:647`
- **Depende de / relacionado a:** tarefa 079; tarefa 045 (data do estorno, aberta)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando alguém paga um título da caixa B com o dinheiro de uma conta da caixa A, o sistema cria a transferência A → B. Depois, um editor que só tem acesso a B consegue estornar essa baixa e, no padrão da tela, a transferência é apagada: o saldo da conta de A muda sem que essa pessoa tenha permissão em A.

### Evidência e análise técnica
- Para criar a transferência da baixa, `settleInTx` exige escrita na caixa da conta de origem (`settlements.ts:96-97`). Para apagar uma transferência avulsa, `deleteTransfer` exige escrita nas duas caixas (`transfers.ts:92-95`, comentário "Exige escrita nas duas caixas").
- `reverseSettlement` confere só `assertWrite(title.caixaId)` da perna pedida (`settlements.ts:224`). Com `undoTransfer` (padrão `true`, `schemas/index.ts:488`), apaga as transferências de todas as pernas (`settlements.ts:236-259`), e os dois movimentos vão junto, inclusive o da conta na outra caixa.
- Pela perna do espelho é o mesmo: quem escreve só na caixa do espelho estorna a perna do original e apaga a transferência que financiou essa perna, em duas caixas onde não escreve.

### Verificação (tentativa de refutação)
- Banco: `transfer_assert_movements` e `settlements_mirror_check` não olham o ator; o `movements_period_lock` só barra mês fechado (coberto em `operation.test.ts:107-151`).
- O estorno das duas pernas juntas é obrigatório no banco ("estornadas juntas", docs/016), então o movimento de estorno na conta da outra perna é desenho. Já desfazer a transferência é opcional (`undoTransfer`), e há o caminho sem desfazer.
- Testes: `titles.test.ts:151-178` estorna com o admin; nenhum caso com editor de uma caixa só.

### Impacto
Saldo e extrato de uma conta mudam por quem não tem acesso à caixa dela. Se o banco não devolveu o dinheiro para A, os livros de A ficam errados, e o editor de B nem vê a conta afetada. A frequência é baixa: depende de uma baixa paga com conta de outra caixa e de um editor com acesso só a um lado.

## Como reproduzir
1. Admin: título a pagar em `caixaB`; baixa com `financialAccountId = accountB` e `sourceAccountId = accountA` (cria a transferência A → B).
2. Usuário U, editor só de `caixaB`: `POST /api/settlements/<baixa>/reverse { reason: "x" }`.
3. A transferência some e o saldo de `accountA` volta a 100.000, sem U ter escrita em `caixaA`.

## Solução proposta
1. Em `reverseSettlement`, antes de apagar, ler as contas `from`/`to` das transferências que vão sair e exigir `canWrite` nas caixas delas.
2. Sem essa escrita: com `undoTransfer` pedido, 403 com mensagem pt-BR ("estorne sem desfazer a transferência ou peça a quem edita a caixa de origem"). Na tela, desmarcar "desfazer transferência" por padrão quando a origem não é editável.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/settlements.ts
+++ b/apps/server/src/services/settlements.ts
@@
     if (input.undoTransfer) {
       const doomed = await tx
-        .select({ id: transfers.id })
+        .select({ id: transfers.id, from: transfers.fromAccountId, to: transfers.toAccountId })
         .from(transfers)
         .where(inArray(transfers.settlementId, legs.map((l) => l.id)));
+      // Mesma regra de deleteTransfer: escrita nas duas caixas da transferência.
+      for (const d of doomed) {
+        for (const accountId of [d.from, d.to]) ctx.access.assertWrite((await getAccount(ctx, accountId, tx)).caixaId);
+      }
```

## Critérios de aceite
- [ ] Editor só da caixa do título não desfaz a transferência que mexe em conta de outra caixa (403); o estorno sem desfazer continua possível.
- [ ] Quem escreve nas duas caixas continua estornando com o padrão.

## Testes recomendados
`test/titles.test.ts`, no `describe('baixas (spec 005)')`: o cenário de "pagar título da caixa B com conta da caixa A", com um editor só de `caixaB` estornando com `undoTransfer: true` (403, transferência intacta) e com `undoTransfer: false` (200).

## Limitações e suposições
Nada foi executado. A mensagem e o padrão da caixa de seleção na tela ficam para a triagem.

## Análise (triagem)

## Resolução (executor)
