# 008 — Categorias, exclusão e auditoria

## Categorias
- Plano **global**, separado em receita e despesa, em dois níveis (grupo → subcategoria), com cor e ícone; tags livres opcionais.
- Cada caixa pode ocultar as categorias que não usa.
- Relatórios alternam entre **competência** (padrão) e **caixa**.

## Exclusão
- Registros com vínculo/movimento são **arquivados** (somem das listas, continuam nos relatórios).
- A exclusão física só é permitida sem vínculos.

## Auditoria e fechamento
- Log de auditoria de toda alteração (quem, quando, antes/depois, humano ou agente).
- **Fechamento de mês** por caixa (após conciliação) bloqueia a edição até o admin reabrir. O mês fechado congela os títulos pela competência e as baixas, movimentos e compras de cartão pela data deles; vencimento, descrição, notas e o estorno de uma baixa (lançado na data do estorno) continuam permitidos.
