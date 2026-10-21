---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: alta
criada: 2026-10-20
commit:
---

# Contratos sobre séries recorrentes no banco (F20)

## Descrição
A seção "Banco (dba)" da spec [034](../docs/034-contratos-sobre-series.md), com a seção "Migração dos contratos existentes (produção)": séries com `contract_id`, alvo (conta ou cobrança esperada no cartão) e ajustes de reconhecimento; `titles.planned_account_id` aceitando `cash` e sem conta de passagem; `card_purchases` ligadas à ocorrência; `contracts` com vigência e sem as colunas da 033; ciclos e tarefas de renovação como histórico; `contract_payments` pelas obrigações; a migração dos contratos de produção sem perder baixa, conciliação, auditoria nem documento. Atualizar a 016 e o `schema.sql`.

Ordem: primeira da F20; a [044](044-contratos-sobre-series-na-aplicacao.md) depende desta.

## Como reproduzir
Não se aplica (redesenho). Pronto: pgTAP passando em `make -C database test`, inclusive a migração de contratos antigos.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-20).

**Executor designado: dba.**

## Resolução (executor)
Migration `database/migrations/0052_contracts_on_series.sql`, pgTAP `database/tests/0052_contracts_on_series.sql` (e os da 0007, 0008, 0013, 0032 e 0051 ajustados ao modelo novo), teste de migração com dados `database/migration-tests/0052_contracts_on_series/` (`make test-migration M=0052`), `schema.sql` regravado, [016](../docs/016-banco-de-dados.md) e o resumo no `docs/INDEX.md` atualizados.

**Decisões do banco** (a 034 deixava em aberto):

- **Cobrança esperada no cartão**: tabela `card_recurring_charges` (chave = a série; pagadora, recebedor, categoria, descrição, valor) com o calendário em `recurrence_rules`, cuja `caixa_id` é a do cartão (o `card_caixa_id` da spec é essa coluna). Valor "dali em diante" em `card_recurring_charge_amounts` (degraus a partir da ocorrência n ≥ 2) e `card_recurring_charge_amount(série, n)`. Tabela à parte, e não colunas na série, para as regras de cartão (pagadora `general`, categoria de despesa) não pesarem na série de títulos, que continua com o modelo na ocorrência mais recente.
- **Ajustes de reconhecimento**: colunas em `recurrence_rules` (`match_window_days`, `late_fee_percent`, `interest_month_percent`, `early_discount_percent`, `tolerance_cents`, `auto_settle`), com os limites da 033; valem para série de títulos e de cartão.
- **`titles.contract_cycle_id`/`contract_installment`**: ficam como histórico nos títulos migrados (o n/N do ciclo, a FK para o ciclo, o descenso fiel); não se preenchem em títulos novos.
- **Série com caixa** (`recurrence_rules.caixa_id NOT NULL`): o lado original das ocorrências fica nela (no COMMIT). As séries que já existiam ganharam a caixa do lado original da ocorrência mais recente; a que tinha ocorrências em caixas diferentes foi dividida (a parte que sai termina no último vencimento dela); as órfãs (sem títulos) saíram.
- **Worker**: a série de contrato migrada é ancorada no último vencimento e termina nele, então a ocorrência N + 1 cai depois do fim (a migração confere); a uma ocorrência por série e caixa continua no índice único.
- **Tarefas de renovação**: o status `open` saiu (nenhuma nova abre); as abertas viraram `closed`. `contract_cycles` passou a aceitar vigências sem os campos do ciclo de parcelas (fim informado ou sem fim, só no último), com `ends_on`/`installments_count` calculados por trigger quando os campos existem (backups antigos continuam importando).
- **`auto_settled`** também com `created_entry = purchase` (a compra criada sem confirmação na fatura). Notificação `contract_charge_missing`.

**Verificação**: `make -C database test` completo passou (48 arquivos, 3718 testes); `make test-migration M=0052` passou (subida 42, descida 29, subida 42 asserções; contrato de dois ciclos com aditivo e reajuste, baixas com transferência, desconto, parcial e estornada, linhas `transfer_settlement` automática e `settlement`, rescindido espelhado com trimestral no dia 31, multa, parcela única, rascunho, encerrado, séries comuns, órfã e dividida). Também up → down → up numa cópia do banco de desenvolvimento (1 contrato, 2 ciclos, 24 parcelas).

A aplicação (tarefa [044](044-contratos-sobre-series-na-aplicacao.md)) precisa regenerar o schema Drizzle (`pnpm db:pull`) e adaptar o que o relatório do DBA lista (worker, `contract_payments`, backup, constraints novas).
