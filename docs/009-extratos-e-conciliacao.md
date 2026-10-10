# 009 — Extratos e conciliação

- Import OFX e CSV (com mapeamento de colunas salvo por conta); o arquivo original é guardado como anexo. Dedup por FITID ou hash.
- Casamento assistido: cada linha procura um movimento ou título em aberto (valor, data ±3 dias, entidade/descrição) e fica `conciliada`, `sugerida` (confirmação em lote) ou `nova` (vira baixa de um título ou movimento avulso).
- A tela compara o saldo do banco com o do app e aponta a divergência.
- Classificação: regras aprendidas a partir das correções do usuário (descrição → entidade/categoria); o que não casa recebe sugestão do agente de IA ([011](011-agentes-de-ia.md)), pendente de aprovação em lote.
- Open Finance (Pluggy/Belvo) é uma fase futura, atrás de um adaptador.
