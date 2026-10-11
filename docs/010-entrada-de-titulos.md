# 010 — Entrada de títulos

- Linha digitável/código de barras de boleto (bancário e convênio): banco, valor, vencimento.
- PIX copia-e-cola (BR Code): chave, recebedor, valor, cidade; acha ou cria a entidade.
- Leitura de PDF/imagem por IA (boleto, nota, comprovante) para pré-preencher o título: `/api/title-entry/document`, feita pelo agente dos fluxos ([011](011-agentes-de-ia.md)); sem agente de IA configurado, 501 e o formulário fica manual.
- Import de NF-e (XML): o emitente vira entidade, com valor, data e itens; o XML fica como anexo e as duplicatas sugerem os vencimentos. Vários títulos (parcelas, os dois lados do espelho) apontam para a mesma nota; reimportar a mesma chave devolve a nota existente.
