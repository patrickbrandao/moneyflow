# 010 — Entrada de títulos

- Linha digitável/código de barras de boleto (bancário e convênio): banco, valor, vencimento.
- PIX copia-e-cola (BR Code): chave, recebedor, valor, cidade; acha ou cria a entidade.
- Leitura de PDF/imagem por IA (boleto, nota, comprovante) para pré-preencher o título: `/api/title-entry/document`, feita pelo agente dos fluxos ([011](011-agentes-de-ia.md)); sem agente de IA configurado, 501 e o formulário fica manual.
- Import de NF-e (XML): o emitente vira entidade, com valor, data e itens; o XML fica como anexo e as duplicatas sugerem os vencimentos. Vários títulos (parcelas, os dois lados do espelho) apontam para a mesma nota; reimportar a mesma chave devolve a nota existente.
- **Chave de acesso com CNPJ alfanumérico** (NT 2025.001): 44 caracteres no formato `[0-9]{6}[0-9A-Z]{12}[0-9]{26}`.
  - As posições 7 a 20 são o CNPJ do emitente: 12 alfanuméricos + 2 DVs numéricos.
  - O DV da chave (posição 44) é o módulo 11 sobre os 43 primeiros caracteres, cada um valendo ASCII − 48, com pesos de 2 a 9 a partir da direita (resto < 2 → 0). Para uma chave toda numérica, dá o mesmo resultado de antes.
  - A chave é normalizada para maiúsculas antes de validar e gravar.
  - A mesma regra vale no parser (`isValidNfeAccessKey`/`nfeAccessKeyDv` no shared) e no banco (`is_valid_nfe_access_key`; [016](016-banco-de-dados.md)).
  - O emitente e o destinatário com CNPJ alfanumérico viram ou casam entidades como os numéricos ([003](003-entidades.md)).
- PIX copia-e-cola com chave CNPJ alfanumérica: reconhecida e casada com a entidade pelo documento ou pela chave.
