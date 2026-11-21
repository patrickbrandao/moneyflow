---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-11-21
commit:
---

# Regras do espelho e da conciliação que a docs/016 atribui ao banco, mas só a aplicação garante

- **Severidade:** baixa
- **Confiança:** confirmado (o banco aceita os quatro estados); nenhum caminho atual da aplicação os produz
- **Categoria:** ponto fraco
- **Subcategoria:** checagem deferida incompleta ou ausente
- **Arquivos afetados:** `database/schema.sql:9692-9758` (`titles_mirror_check`), `database/schema.sql:4557-4575` (`caixas_validate`), `database/schema.sql:8749-8794` (`settlements_mirror_check`), `database/schema.sql:4754-4796` (`card_invoice_items_validate`), `database/schema.sql:7327-7339` (`movements_validate_statement`, para comparar), `apps/server/src/services/caixas.ts:148-153`, `apps/server/src/services/settlements.ts:104-138`, `docs/016-banco-de-dados.md:67-68,91`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O banco deveria barrar sozinho um par de títulos espelhados que ficou incoerente, mesmo que um erro da aplicação tente gravá-lo (`database/AGENTS.md`, convenções). Há quatro casos em que ele aceita o estado errado e só a aplicação impede. Hoje nenhuma tela faz isso, mas uma ferramenta nova, um script ou uma restauração pode fazer, e ninguém percebe.

### Evidência e análise técnica
1. **Mudar a caixa de um lado do espelho passa.** `titles_mirror_check` (`schema.sql:9723-9732`) confere, para o título `t` que mudou, que o espelho `m` está em `t.counterparty_caixa_id` e que o titular da caixa de `m` é `t.entity_id`. Não confere o sentido inverso: `m.counterparty_caixa_id = t.caixa_id` e titular de `t.caixa_id = m.entity_id`. Esse lado só é checado quando o trigger roda para `m`. Um `UPDATE titles SET caixa_id = <outra> WHERE id = t` (título sem baixa e sem série) dispara só o evento de `t`, passa, e deixa `m` apontando para a caixa antiga. A `docs/016:67` diz que "cada título está na caixa cujo titular é a contraparte do outro". O teste `database/tests/0008_titles.sql:189-226` cobre valor, vencimento, ligação e lado, mas não a troca de caixa.
2. **Trocar o titular de uma caixa com títulos passa.** O espelho depende do titular (`titles_mirror_caixa_check`), e o contrato também (`contracts_entity_check`, `contracts_counterparty_caixa_check`). `caixas_validate` (`schema.sql:4557-4575`) só trava `kind`. A aplicação recusa a troca com títulos ligados (`caixas.ts:148-153`, "O titular define os espelhos: com títulos ligados, não muda"), e o `FOR UPDATE` na caixa (`caixas.ts:145`) conflita com o `FOR KEY SHARE` da FK de um título novo. Por isso não há corrida pela aplicação. Mesmo assim, qualquer `UPDATE caixas SET holder_entity_id` fora desse serviço (tool, script, restauração) passa e deixa os espelhos e contratos da caixa incoerentes.
3. **Baixa num título espelhado sem a perna do espelho passa.** `settlements_mirror_check` (`schema.sql:8761-8767`) só confere a reciprocidade quando `mirror_settlement_id` existe. Uma baixa sem perna num título com `mirror_title_id` é aceita, e os dois lados do par ficam com status diferentes (um `paid`, o outro `open`). A `docs/016:68` diz que "as duas pernas da baixa de um par espelhado ficam ligadas de forma recíproca, nos dois títulos do par". Hoje só `settleInTx` (`settlements.ts:104-138`) grava baixa, e sempre com as duas pernas. O banco também deixa ligar depois, como espelhos, dois títulos com baixas diferentes (`0008_titles.sql:173-187`: "par também pode ser ligado depois").
4. **Item de fatura conciliado pode mudar de valor.** Para movimentos existe `movements_validate_statement` (`schema.sql:7327-7339`): movimento conciliado não muda de conta nem de valor. Para `card_invoice_items` não há equivalente. `card_invoice_items_validate` só trava fatura fechada, e `card_purchase_assert` só exige que a soma das parcelas bata. Redistribuir o valor entre as parcelas de uma compra em fatura aberta (60/40 no lugar de 50/50) passa, e a linha `matched` continua presa a um item cujo valor não é mais o oposto do dela (a regra de `statement_lines_validate`, `schema.sql:9326-9336`, só roda quando a linha muda).

### Verificação (tentativa de refutação)
- Caso 1: `titles_validate_status` recusa trocar a caixa de título com baixa, e `recurrence_rule_assert` recusa em título de série. Sobra o título avulso em aberto, sem conta prevista, que é o caso comum de espelho.
- Caso 2: nenhum trigger em `caixas` olha `titles` nem `contracts`.
- Caso 3: nenhum trigger de `titles` olha `settlements`, e nenhum de `settlements` olha `titles.mirror_title_id`.
- Caso 4: `grep` em `apps/server/src` acha só `UPDATE card_invoice_items SET payer_caixa_id` (`cards.ts:368`). A aplicação não mexe em valor de parcela, então é só uma lacuna de defesa.
- A spec não abre exceção para nenhum dos quatro.

### Impacto
Sem caminho na aplicação hoje, o risco é latente. O que dispara é uma tool nova de agente, uma correção manual por SQL, a restauração de um backup editado ou uma regressão. Quando acontece, os relatórios consolidados (`is_internal`), o canvas e o status do par ficam errados sem nenhum erro.

## Como reproduzir
- Caso 1: par espelhado avulso de C1 com C2. `BEGIN; UPDATE titles SET caixa_id = 'C3' WHERE id = '<original>'; COMMIT;`, com C3 caixa geral diferente de C2 e o título sem baixa e sem conta prevista, passa.
- Caso 3: `INSERT INTO settlements (title_id, settled_on, amount_cents) VALUES ('<um lado do par>', '2026-11-21', <valor>);` sem perna, depois `COMMIT`: passa, e só um lado fica `paid`.
- Caso 4: compra parcelada em 2 em fatura aberta com a parcela 1 conciliada. `UPDATE card_invoice_items SET amount_cents = amount_cents + 100 WHERE id = <p1>; UPDATE ... - 100 WHERE id = <p2>; COMMIT;` passa.

## Solução proposta
1. `titles_mirror_check`: conferir também o sentido inverso, `m.counterparty_caixa_id = t.caixa_id` e titular de `t.caixa_id = m.entity_id`, com a mesma constraint `titles_mirror_caixa_check`.
2. `caixas_validate`: recusar a troca de `holder_entity_id` quando existe título com `caixa_id` ou `counterparty_caixa_id` igual à caixa, ou contrato com `caixa_id` ou `counterparty_caixa_id` igual a ela (`23514 caixas_holder_locked_check`). A consulta da aplicação vira só a mensagem amigável.
3. Constraint trigger deferido em `settlements` (INSERT): baixa em título com `mirror_title_id` exige `mirror_settlement_id`. Em `titles_mirror_check`, ao ligar um par, a soma das baixas ativas dos dois lados tem de ser igual (`settlements_mirror_required_check`).
4. Trigger `card_invoice_items_validate_statement`, BEFORE UPDATE OF `amount_cents` e `card_invoice_id`: recusar se há linha `matched` no item, como em movimentos (`statement_lines_card_item_check`).
5. Atualizar a `docs/016` (seções *Espelho*, *Baixas* e *Extratos*) dizendo que essas regras estão no banco.

## Critérios de aceite
- [ ] Os três roteiros de "Como reproduzir" falham no COMMIT (ou na hora, no caso 4) com a constraint nomeada.
- [ ] A troca de titular de caixa sem títulos nem contratos continua passando.
- [ ] Todo o pgTAP e os testes de integração de títulos, cartão e conciliação passam sem mudança, porque a aplicação já respeita as quatro regras.

## Testes recomendados
- `database/tests/0008_titles.sql`: trocar a caixa de um lado do par (recusado) e trocar a dos dois lados junto (aceito, se coerente).
- `database/tests/0004_caixas.sql`: trocar o titular com título ou contrato ligado (recusado) e sem eles (aceito).
- `database/tests/0009_settlements.sql`: baixa sem perna num título espelhado (recusada) e com as duas pernas (aceita).
- `database/tests/0014_statements.sql`: mudar o valor do item conciliado (recusado) e do item só sugerido (aceito).

## Limitações e suposições
Nada foi executado. A regra 3 depende de que a restauração do backup traga as duas pernas juntas, o que o export já faz (as baixas vão todas no arquivo). Isso não foi verificado em `backup/import.ts`.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Os quatro casos se confirmaram no schema:
1. `titles_mirror_check` só conferia o sentido do título que mudou para o espelho.
2. `caixas_validate` só travava `kind`.
3. `settlements_mirror_check` só olhava baixas com `mirror_settlement_id`, e nenhum trigger ligava a baixa ao `mirror_title_id` do título.
4. `card_invoice_items` não tinha o equivalente de `movements_validate_statement`.

A aplicação já respeita as quatro regras. `settleInTx` grava sempre as duas pernas, nenhum serviço liga títulos existentes como par, e o backup importa as baixas e os títulos ligados na mesma unidade.

## Resolução (executor)

Migration `database/migrations/0060_mirror_and_reconciliation_invariants.sql`; teste `database/tests/0060_mirror_and_reconciliation_invariants.sql`.

1. `titles_mirror_check` confere também que `t.caixa_id = m.counterparty_caixa_id` e que o titular de `t.caixa_id` é `m.entity_id`, com a mesma constraint `titles_mirror_caixa_check`.
2. `caixas_validate` recusa trocar `holder_entity_id` enquanto houver dependências (`23514 caixas_holder_locked_check`):
   - títulos com `caixa_id` ou `counterparty_caixa_id` = a caixa;
   - contratos com `caixa_id` ou `counterparty_caixa_id` = a caixa;
   - encargos do emissor no cartão (`card_purchases.kind = 'charge'`, cujo recebedor é o titular). Este caso vai além do que a tarefa pedia, pela mesma razão.
3. Perna do espelho, com a constraint `settlements_mirror_required_check`:
   - Constraint trigger novo `settlements_mirror_required_check` (deferido, AFTER INSERT OR UPDATE OF mirror_settlement_id): baixa ativa em título com `mirror_title_id` exige `mirror_settlement_id`.
   - Ao ligar o par, `titles_mirror_check` recusa baixa ativa sem perna em qualquer dos dois lados.
   - Decisão: exigir a perna de cada baixa ativa, em vez de só "a soma igual". Com a reciprocidade de `settlements_mirror_check`, isso implica a soma igual e é mais forte. Baixa estornada sem perna não impede ligar o par.
4. Trigger novo `card_invoice_items_validate_statement` (BEFORE UPDATE OF amount_cents, card_invoice_id): o item com linha `matched` não muda de valor nem de fatura (`23514 statement_lines_card_item_check`). O item só sugerido continua livre.

Dados que já existiam:
- As regras valem daqui em diante.
- A migration emite um `WARNING` com a contagem do que já as viola (lado de espelho incoerente, baixa sem perna, item conciliado com valor diferente).
- No banco de desenvolvimento não apareceu nenhum.

Testes:
- os três roteiros de "Como reproduzir" falham com a constraint nomeada;
- trocar os dois lados juntos, de forma coerente, passa;
- titular de caixa sem dependências e outros campos continuam livres;
- baixa com as duas pernas passa, e soltar as pernas é recusado;
- ligar o par com baixa solta é recusado, e com ela estornada passa;
- o item sugerido é redistribuído e a pagadora do conciliado muda.

Verificação:
- `make test` completo (56 arquivos, 4078 testes) passou sem mudar nenhum teste antigo.
- `docs/016` atualizada (Caixas, Espelho, Baixas e Extratos). `make dump` rodado.

Para a aplicação, nada obrigatório. Opcional: traduzir em `apps/server/src/errors.ts` as constraints novas `caixas_holder_locked_check` (hoje só a checagem de títulos de `caixas.ts:148-153` tem mensagem própria), `settlements_mirror_required_check` e `statement_lines_card_item_check`. Também convém confirmar que `test/backup.test.ts` passa, porque a ida e volta leva as duas pernas na mesma unidade.
