# 008 — Categorias, exclusão e auditoria

## Categorias
- Plano **global**, separado em receita e despesa, em dois níveis (grupo → subcategoria), com cor e ícone; tags livres opcionais.
- Cada caixa pode ocultar as categorias que não usa.
- Relatórios alternam entre **competência** (padrão) e **caixa**.

## Exclusão
- Registros com vínculo/movimento são **arquivados** (somem das listas, continuam nos relatórios).
- A exclusão física só é permitida sem vínculos.

## Auditoria e fechamento
- Log de auditoria de toda alteração (quem, quando, antes/depois, humano ou agente). Toda transação de escrita da aplicação define o ator (`app.user_id`, `app.actor_kind`); o histórico de um registro aparece na tela dele e o log geral fica para o admin. **Sem retenção por enquanto**: o log não é expurgado.
- **Fechamento de mês** por caixa (após conciliação: com linhas de extrato do mês ainda não conciliadas, a tela pede confirmação para fechar assim mesmo) bloqueia a edição até o admin reabrir. O mês fechado congela os títulos pela competência e as baixas, movimentos e compras de cartão pela data deles; vencimento, descrição, notas e o estorno de uma baixa (lançado na data do estorno) continuam permitidos.
- Caixa com mês fechado não é excluída: é arquivada.
