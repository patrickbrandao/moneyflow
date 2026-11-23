# 008 — Categorias, exclusão e auditoria

> **Conteúdo:** Plano global de categorias, regime de competência e de caixa, arquivamento em vez de exclusão, auditoria (sem retenção por enquanto) e fechamento de mês após a conciliação.

## Categorias
- Plano **global**, separado em receita e despesa, em dois níveis (grupo → subcategoria), com cor e ícone; tags livres opcionais.
- Cada caixa pode ocultar as categorias que não usa.
- Relatórios alternam entre **competência** (padrão) e **caixa**.

## Exclusão
- Registros com vínculo/movimento são **arquivados** (somem das listas, continuam nos relatórios).
- A exclusão física só é permitida sem vínculos.
- **Conta financeira** com histórico só é arquivada com saldo zero (422 `account_archive_balance`: zere com uma transferência ou um lançamento avulso), porque a arquivada sai do saldo da caixa. Arquivada, não recebe baixa, lançamento avulso, transferência nem extrato novo (422 `account_archived` e `statement_account_archived`); o estorno de uma baixa antiga e a leitura dos lotes continuam (2026-11-21, tarefa 080).

## Auditoria e fechamento
- Log de auditoria de toda alteração (quem, quando, antes/depois, humano ou agente). Toda transação de escrita da aplicação define o ator (`app.user_id`, `app.actor_kind`); o histórico de um registro aparece na tela dele e o log geral fica para o admin. **Sem retenção por enquanto**: o log não é expurgado.
- **Fechamento de mês** por caixa (após conciliação: com linhas de extrato do mês ainda não conciliadas, a tela pede confirmação para fechar assim mesmo) bloqueia a edição até o admin reabrir. Só se fecha até o mês atual (no fuso de São Paulo), pela tela, pela API e pela tool `close_month` (422 `closing_future_month`); a série que o worker não consegue materializar (por exemplo, num mês futuro fechado antes dessa trava) vai para o log com o id e o motivo (2026-11-21, tarefa 082). O mês fechado congela os títulos pela competência e as baixas, movimentos e compras de cartão pela data deles; vencimento, descrição, notas e o estorno de uma baixa (lançado na data do estorno) continuam permitidos.
- Caixa com mês fechado não é excluída: é arquivada.
