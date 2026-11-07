---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-07
commit:
---

# Parsers OFX e XML com custo quadrático e sem limite de profundidade (trava a API)

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** DoS algorítmico / esgotamento de CPU e pilha
- **Arquivos afetados:** `packages/shared/src/parsers/ofx.ts:75-96`, `packages/shared/src/parsers/xml.ts:66-71,101,122-143`, `apps/server/src/services/statements.ts:351-358`, `apps/server/src/routes/statements.ts:48-50`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Um arquivo de extrato montado com milhões de tags abertas e fechamentos sem par faz o servidor recalcular a pilha inteira a cada tag. Como a leitura é síncrona e a API roda num único processo, o sistema fica fora do ar para todos enquanto o arquivo é lido.

### Evidência e análise técnica
- A cada fechamento de tag, `const idx = stack.map((n) => n.name).lastIndexOf(name);` (`ofx.ts:85`, `xml.ts:70`) aloca e percorre um array do tamanho da pilha.
- Não há limite de profundidade (`ofx.ts:94`, `xml.ts:101`: `else if (!selfClosing) stack.push(node)`), e `findAll`/`findFirst` são recursivos (`xml.ts:122-143`).
- Pior caso: `<OFX>` seguido de cerca de 10 MB de `<A>` (3,3 milhões de níveis) e 10 MB de `</B>` (2,6 milhões de fechamentos sem par), da ordem de 10^13 operações. Com 200 KB, cerca de 10^9 operações, ou alguns segundos por requisição.

### Verificação (tentativa de refutação)
- A única barreira é o corpo de 20 MB + 64 KB (`UPLOAD_BODY_LIMIT`).
- `POST /api/statements/inspect` → `inspectStatement` (`statements.ts:351-358`) decodifica e chama `readOfxStatements` antes de qualquer checagem de acesso. O `resolveTarget` só roda depois, e só quando a conta é informada. Qualquer autenticado chega lá, inclusive um viewer. O OFX SGML passa por esse caminho (`ofx.ts:199-202`).
- Também alcançam o parser: `POST /api/statement-imports` (editor) e `POST /api/title-entry/nfe` (`parseXml`).
- Os comentários dizem só "tolerante". Nada indica que seja intencional.

### Impacto
Negação de serviço da API, para todos os usuários, com uma única requisição de qualquer usuário autenticado. A recursão profunda dá `RangeError` (500), que é benigna sozinha.

## Como reproduzir
Enviar a `POST /api/statements/inspect` um corpo `<OFX>` + `"<A>".repeat(N)` + `"</B>".repeat(N)` com N de algumas dezenas de milhares e medir o tempo de resposta e o bloqueio de outras requisições.

## Solução proposta
- Procurar o nome de trás para frente, sem alocar.
- Limitar a profundidade (por exemplo 64, de sobra para OFX e NF-e) e o número de nós (por exemplo 500 mil). Acima disso, lançar o erro pt-BR de arquivo inválido.
- Opcional: checar o acesso (`resolveTarget`) antes de interpretar no `inspect`.
- Registrar os limites em `docs/009-extratos-e-conciliacao.md` e `docs/010-entrada-de-titulos.md`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/packages/shared/src/parsers/ofx.ts
+++ b/packages/shared/src/parsers/ofx.ts
@@
     if (tag.startsWith('/')) {
       const name = tag.slice(1).trim().toUpperCase();
-      const idx = stack.map((n) => n.name).lastIndexOf(name);
+      let idx = stack.length - 1;
+      while (idx > 0 && stack[idx]!.name !== name) idx -= 1;
       if (idx > 0) stack.length = idx;
       continue;
     }
@@
     if (text.trim()) node.text = decodeXmlEntities(text.trim());
-    else if (!selfClosing) stack.push(node);
+    else if (!selfClosing) {
+      if (stack.length > MAX_DEPTH) throw new Error('Arquivo OFX inválido: aninhamento profundo demais.');
+      stack.push(node);
+    }
   }
```
A mesma correção vai em `xml.ts:70` e `:101`. Com o limite, o laço reverso fica O(n·64).

## Critérios de aceite
- [ ] Os arquivos patológicos de 20 MB são recusados em menos de 1 s.
- [ ] Os fixtures atuais de OFX, CSV e NF-e continuam passando.
- [ ] `POST /api/statements/inspect` com o arquivo patológico responde 422.
- [ ] Specs 009 e 010 atualizadas.

## Testes recomendados
Unitários em `packages/shared/test` (OFX e XML): profundidade acima do limite lança erro, e uma massa de fechamentos sem par termina em poucos ms. Integração no `inspect`. Nada disso foi executado nesta auditoria.

## Limitações e suposições
O tempo real não foi medido; a estimativa vem da complexidade. O parse continua síncrono: um OFX válido de 20 MB ainda leva algum tempo, mas o custo fica linear.

## Análise (triagem)

Confirmado: `stack.map((n) => n.name).lastIndexOf(name)` a cada fechamento em `packages/shared/src/parsers/ofx.ts` e `xml.ts`, sem limite de profundidade nem de nós; `inspectStatement` interpreta antes de qualquer checagem de acesso. Executor: app.

## Resolução (executor)

- `packages/shared/src/parsers/xml.ts`: `XML_MAX_DEPTH = 64`, `XML_MAX_NODES = 500_000` e as mensagens pt-BR (`XML_TOO_DEEP`, `XML_TOO_MANY_NODES`); a classe `OpenStack` (pilha dos abertos com a contagem por nome: `push` recusa acima da profundidade, `close` ignora em O(1) o fechamento sem par e procura o com par de trás para frente, sem alocar), usada no `parseXml` e no `parseOfxTree` (`ofx.ts`), que também contam os elementos. O fechamento custa O(1) sem par e no máximo O(64) com par e a recursão de `findAll`/`findFirst` fica rasa. O erro vira 422 `statement_format` no extrato e `nfe_invalid` na NF-e (os chamadores já traduziam). Os fixtures não mudaram de resultado.
- Testes: `packages/shared/test/parser-limits.test.ts` (novo: profundidade acima e no limite, massa de 1 milhão de fechamentos sem par, com teto de tempo folgado, elementos demais, o arquivo patológico de ~20 MB recusado em menos de 1 s, para OFX e XML); integração em `apps/server/test/statements.test.ts` ("OFX montado … 422 e rápido": `POST /api/statements/inspect` por um usuário comum e `POST /api/title-entry/nfe`, ambos 422). `ofx.test.ts` e `nfe.test.ts` seguem passando.
- Specs: `docs/009-extratos-e-conciliacao.md` e `docs/010-entrada-de-titulos.md`. A checagem de acesso antes do parse no `inspect` (opcional) não foi feita: com o custo linear, não é mais necessária.
