---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Fechar o mês não espera as escritas em andamento naquele mês (escrita entra no mês fechado)

- **Severidade:** baixa
- **Confiança:** provável (a corrida vem da semântica do READ COMMITTED e da falta de trava; não foi reproduzida)
- **Categoria:** ponto fraco
- **Subcategoria:** condição de corrida na trava de mês fechado
- **Arquivos afetados:** `database/schema.sql:8064-8073` (`period_assert_open`), `database/schema.sql:8144-8149` (`period_is_closed`), `database/schema.sql:9765-9785` (`titles_period_lock`), `database/schema.sql:8816-8825` (`settlements_period_lock`), `database/schema.sql:7263-7287` (`movements_period_lock`), `database/schema.sql:4952-4974` (`card_purchases_period_lock`), `database/schema.sql:8087-8107` (`period_closings_provisional_check`), `database/schema.sql:9173-9181` (linha de provisório), `apps/server/src/services/audit.ts:162-172`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se alguém fecha um mês no mesmo instante em que outra pessoa (ou o worker, ou um agente) lança ou baixa algo nesse mês, as duas operações podem dar certo. O mês fica fechado com um lançamento que entrou depois do fechamento, sem nenhum erro, e o "mês fechado não muda" deixa de valer.

### Evidência e análise técnica
A trava de mês é uma leitura simples: os triggers `*_period_lock` chamam `period_assert_open` → `period_is_closed`, que faz `SELECT EXISTS (... FROM period_closings WHERE caixa_id = ... AND month = ...)` sem nenhum bloqueio (`schema.sql:8144-8149`). Fechar é um `INSERT INTO period_closings` (`audit.ts:168-170`), e o único trigger de INSERT, `period_closings_provisional_check`, também só lê (`schema.sql:8087-8107`).

No READ COMMITTED, com duas transações A (escrita no mês M) e B (fechamento de M):
1. A insere um título, baixa ou movimento em M. O trigger não vê fechamento e passa.
2. B insere o fechamento de M. A checagem de provisório não vê as linhas não confirmadas de A e passa.
3. A e B confirmam. Não há linha nem índice em comum para gerar conflito.

O mesmo vale para a linha de lote provisório inserida em M (`schema.sql:9173-9181`) contra a checagem `period_closings_provisional_check`: o mês fecha com uma linha de provisório ativo, coisa que a spec 031 e a `docs/016` (seção *Fechamento de mês*) dizem que não acontece.

### Verificação (tentativa de refutação)
- Não há `pg_advisory_xact_lock`, `FOR SHARE` nem `LOCK TABLE` nos triggers de período nem em `closeMonth` (`audit.ts:162-172`).
- O pré-teste de pendências do `closeMonth` (`audit.ts:164-167`) roda fora da transação e não protege contra a corrida.
- A janela é curta (entre o trigger de A e o COMMIT de B), mas o worker (séries, auto-baixa da conciliação, fechamento automático de fatura) e os agentes escrevem sem ninguém olhando.
- `database/tests/0016_period_closings.sql` testa cada trava numa única sessão, não a concorrência.

### Impacto
Raro, mas silencioso: um mês conciliado e fechado passa a ter movimento, baixa ou título que ninguém viu entrar. Os relatórios do mês mudam depois do fechamento, e só reabrindo (com o admin) dá para corrigir.

## Como reproduzir
Duas sessões `psql`:
1. S1: `BEGIN; SET LOCAL app.user_id = '<editor>'; INSERT INTO movements (...) VALUES (... occurred_on = '2026-10-15' ...);` (ainda sem COMMIT).
2. S2: `BEGIN; INSERT INTO period_closings (caixa_id, month) VALUES ('<caixa>', '2026-10-01'); COMMIT;` → passa.
3. S1: `COMMIT;` → passa. Outubro fica fechado com o movimento novo.

## Solução proposta
Uma trava consultiva por caixa, compartilhada pelos escritores e exclusiva para quem fecha:
1. Função `period_lock_shared(caixa)`, que faz `pg_advisory_xact_lock_shared(hashtextextended('period:' || caixa, 0))`. Os triggers `*_period_lock`, e o da linha de provisório, chamam essa função numa instrução própria, antes de `period_assert_open`. A trava vem antes da leitura, e no READ COMMITTED a instrução seguinte da função de trigger (VOLATILE) tira um snapshot novo, que já enxerga o fechamento confirmado.
2. Em `period_closings_validate` ou num BEFORE INSERT novo, `pg_advisory_xact_lock(...)` exclusivo da mesma chave, antes da checagem de provisório. Quem fecha espera as escritas em andamento na caixa, e quem escreve depois espera o fechamento e então vê a linha.
3. A chave por caixa, e não por (caixa, mês), evita encher a tabela de locks numa importação grande ou numa restauração de backup. Fechar é raro, então serializar a caixa nesse momento custa pouco.

## Critérios de aceite
- [ ] Com o roteiro de "Como reproduzir", S2 espera S1 terminar, e o fechamento só entra depois do movimento.
- [ ] Com a ordem invertida (fechamento primeiro e aberto), a escrita espera e depois falha com `period_closings_locked_check`.
- [ ] A importação de extrato e a restauração do backup continuam passando, sem estourar `max_locks_per_transaction`.

## Testes recomendados
`database/tests/0016_period_closings.sql` não testa duas sessões. A concorrência vale um teste de integração em `apps/server/test/operation.test.ts` com duas conexões: um lançamento numa transação aberta, o `closeMonth` em paralelo, e a conferência de que o fechamento espera e de que a segunda escrita é recusada. No pgTAP fica a conferência de que os triggers chamam a trava (por exemplo, `pg_locks` com `locktype = 'advisory'` depois de um INSERT).

## Limitações e suposições
Nada foi executado. Supõe o isolamento padrão (READ COMMITTED), que é o que a aplicação usa (`withTx` não muda o nível).

## Análise (triagem)

## Resolução (executor)
