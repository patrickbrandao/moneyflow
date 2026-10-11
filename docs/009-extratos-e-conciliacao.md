# 009 — Extratos e conciliação

- Import OFX e CSV (com mapeamento de colunas salvo por conta); o arquivo original é guardado como anexo. Dedup por FITID ou hash.
- Upload do arquivo cru (até 20 MB); OFX 1.x (SGML) e 2.x (XML), CSV com separador, codificação, formato de data e valor pt-BR configuráveis. Na fatura de cartão em CSV com compras positivas, o sinal é invertido (no app, compra sai).
- Casamento assistido: cada linha procura um movimento ou título em aberto (valor, data ±3 dias, entidade/descrição) e fica `conciliada`, `sugerida` (confirmação em lote) ou `nova` (vira baixa de um título ou movimento avulso).
- A tela compara o saldo do banco com o do app e aponta a divergência.
- Conciliada automaticamente só quando há um único movimento (ou parcela do cartão) do mesmo valor e a data bate ou a descrição é parecida; o resto fica sugerido. Título sugerido, ao confirmar, vira baixa na conta do extrato.
- Classificação: regras aprendidas a partir das correções do usuário (descrição normalizada "contém" → entidade/categoria, escopo da caixa, origem `correction`) e aplicadas na importação; o que não casa recebe sugestão do agente de IA ([011](011-agentes-de-ia.md)), pendente de aprovação em lote.
- Open Finance (Pluggy/Belvo) é uma fase futura, atrás de um adaptador.
