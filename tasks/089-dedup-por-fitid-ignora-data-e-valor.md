---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Dedup por FITID ignora data e valor: FITID repetido descarta lançamento real ou derruba o import

- **Severidade:** média
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** deduplicação de linhas na importação
- **Arquivos afetados:** `apps/server/src/services/statements.ts:260-269`, `apps/server/src/services/statements.ts:396-407`, `apps/server/src/services/statements.ts:460`, `apps/server/src/services/statements.ts:290-302`, `packages/shared/src/parsers/ofx.ts:165`, `database/schema.sql:18823` e `:18837` (índices de dedup), `packages/shared/src/i18n/errors.ts:291-292`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Para não importar a mesma transação duas vezes, o sistema usa o identificador que o banco põe em cada transação do OFX (FITID). Se o banco (ou o conversor de PDF para OFX) repete esse identificador para transações diferentes, a segunda some em silêncio no próximo extrato, ou, se a repetição está no mesmo arquivo, o arquivo inteiro é recusado com "Essa linha já foi importada nesta conta".

### Evidência e análise técnica
- A chave é só o FITID: `if (line.fitid) return \`fitid:${line.fitid}\`.slice(0, 200)` (`statements.ts:263`); data, valor e descrição não entram. O ordinal que separa transações iguais só existe no hash sem FITID (`:264-267`).
- **Entre arquivos**: a linha cujo `fitid:` já existe na conta é tirada de `fresh` sem comparar data nem valor (`statements.ts:398-406`) e só entra na contagem `skippedDuplicates`. Uma transação nova de outro mês com o FITID de uma antiga não é importada, e a resposta não diz qual linha foi descartada nem por quê. A prévia da tool `import_statement` faz o mesmo (`:290-302`).
- **No mesmo arquivo**: duas transações com o mesmo FITID são ambas "novas", e o `INSERT` (`:460`) bate no índice único `statement_lines_account_dedup_key` (`schema.sql:18823`; no cartão, `statement_lines_card_dedup_key`, `:18837`). A transação inteira cai com `23505`, traduzido para "Essa linha já foi importada nesta conta." (`errors.ts:291`), mensagem que não leva o usuário à causa.
- O FITID vem do arquivo sem tratamento (`ofx.ts:165`); no CSV, da coluna mapeada como identificador.

### Verificação (tentativa de refutação)
- A spec define "Dedup por FITID ou hash" (`docs/009-extratos-e-conciliacao.md:3`) e a 016 a chave `fitid:<FITID>`: o comportamento é o especificado, o achado é a falta de defesa quando o FITID não é único, que o OFX exige mas não garante.
- A própria spec 031 (linha 5) registra extratos convertidos de PDF para OFX (Santander); o FITID de um conversor pode ser sequencial por arquivo. Não pude confirmar (sem rede) quais bancos ou conversores repetem FITID; por isso a confiança é "provável" para o efeito, e "confirmado" para o caminho do código.
- Testes: `packages/shared/test/ofx.test.ts:57` confere FITIDs distintos na fixture; nenhum teste importa FITID repetido (no arquivo ou entre arquivos).
- O lote provisório fica fora do índice (spec 031), então ali o FITID repetido entra, e o desmarcar dá `statement_provisional_duplicated`: o problema reaparece depois.

### Impacto
Lançamento real que não aparece na conciliação: a divergência de saldo acusa a diferença sem pista da causa, e o usuário precisa achar a linha faltando no arquivo. No caso do mesmo arquivo, o extrato não entra de jeito nenhum. Frequência depende do banco; quando acontece, repete todo mês.

## Como reproduzir
1. Importar um OFX com `<FITID>1</FITID>` numa transação de 05/10/2026, R$ -50,00.
2. Importar outro OFX (novembro) com `<FITID>1</FITID>` numa transação de 05/11/2026, R$ -80,00: a linha de novembro não entra (`skippedDuplicates: 1`).
3. Um OFX com duas transações diferentes e o mesmo FITID: 409 "Essa linha já foi importada nesta conta."

## Solução proposta
1. Na consulta de dedup, trazer `posted_on` e `amount_cents` das linhas existentes com chave `fitid:` (`statements.ts:398-404` e `:293-299`).
2. Uma chave `fitid:<FITID>` que já existe com outra data **ou** outro valor é colisão: a linha nova recebe a chave de reserva `fitid:<FITID>#<sha256(data|valor|descrição normalizada|ordinal)>` (dentro dos 200 caracteres do `statement_lines_dedup_hash_check`). A mesma regra vale para o FITID repetido dentro do arquivo (a segunda ocorrência com data/valor diferentes ganha a chave de reserva; com tudo igual, o ordinal).
3. As linhas já importadas mantêm `fitid:<FITID>`: o reimport do mesmo arquivo continua deduplicando.
4. A resposta do import e a prévia da tool trazem `fitidCollisions` (quantas e quais), e a tela avisa.

## Critérios de aceite
- [ ] Dois OFX de meses diferentes com o mesmo FITID em transações diferentes: as duas linhas entram, com aviso de colisão.
- [ ] OFX com FITID repetido no mesmo arquivo em transações diferentes é importado.
- [ ] Reimportar o mesmo arquivo continua dando 409 `statement_duplicated`.

## Testes recomendados
`apps/server/test/statements.test.ts`: os três critérios acima, com OFX montados no teste (como em `statement-supersede.test.ts`); unitário de `dedupHashes` com colisão (se a função for para o shared).

## Limitações e suposições
Nada foi executado. A frequência real de FITID repetido nos bancos brasileiros não foi verificada.

## Análise (triagem)

## Resolução (executor)
