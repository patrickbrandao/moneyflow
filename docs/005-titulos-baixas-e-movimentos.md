# 005 — Títulos, baixas, movimentos e transferências

- Cada caixa tem os próprios **títulos** a pagar e a receber: entidade, categoria, competência, vencimento, valor, anotações e anexos.
- Um título recebe uma ou mais **baixas** (parcial, juros, multa, desconto); cada baixa gera um **movimento** numa conta financeira. O estorno de baixa é uma operação própria.
- Recorrência e parcelamento por regra (mensal no dia X, semanal, anual, N parcelas). O worker materializa os títulos até 12 meses à frente; editar "esta e as próximas" reescreve os futuros.
- **Encerrar série** (contrato cancelado, mas ainda restam pagamentos até uma data): na gaveta de uma ocorrência recorrente, "Encerrar série…" escolhe o último vencimento a manter (padrão: o desta ocorrência) e mostra a prévia antes de aplicar (`GET`/`POST /api/titles/:id/series/end`, tool `end_series`).
  - Grava a data em `recurrence_rules.ends_on`. As ocorrências que vencem depois dela e estão em aberto passam a **canceladas**, com o espelho de cada uma; nada é apagado (auditoria e histórico ficam). Canceladas continuam ocupando a vaga da ocorrência, então o worker não as recria nem passa do novo fim.
  - Ocorrência com baixa ativa (parcial ou paga) depois da data **impede** o encerramento: o erro lista as ocorrências (`#n dd/mm/aaaa`) para estorná-las ou escolher uma data a partir do vencimento delas. Baixas estornadas não impedem.
  - **Estender**: escolher uma data mais adiante ou "sem data de fim" reabre as ocorrências canceladas que vencem depois do fim anterior (até a nova data) e materializa o que faltar até o horizonte. Ocorrências canceladas avulsas antes do fim anterior continuam canceladas.
  - O vencimento de referência é o do lado original; encerrar pede escrita na caixa do título original (a série é dele). Vale só para recorrência: parcelamento não tem data de fim. A data não pode ser anterior ao início da série.
  - "Excluir este e os próximos" continua existindo para apagar ocorrências lançadas por engano (some com elas e falha se houver baixa).
- **Transferência** = par de movimentos ligados por `transfer_id`; não conta como receita nem despesa.
- Pagar um título da caixa B com uma conta da caixa A (com permissão) gera automaticamente a transferência A → B e a baixa em B.
- Títulos cuja contraparte é titular de uma caixa são espelhados ([006](006-espelhamento-entre-caixas.md)).
