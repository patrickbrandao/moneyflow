---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Nova entidade importa o endereço e os contatos de um CNPJ consultado antes de trocar o documento

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** estado derivado velho no formulário
- **Arquivos afetados:** `apps/web/src/components/entity/EntityFormModal.tsx:37-38,44-62,81-90,165-175`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao cadastrar uma empresa, a pessoa consulta um CNPJ, percebe que era o errado, digita o certo e salva sem consultar de novo. A empresa nova é gravada com o endereço, o e-mail e o telefone da primeira consulta, de outra empresa.

### Evidência e análise técnica
- `lookup` só é escrito em `lookupCnpj()` (`:47-62`) e nunca volta a `null`: nem quando o documento muda (`onChange` em `:118`), nem quando o tipo passa de empresa para pessoa (`:106`).
- No `submit` de uma entidade nova, `if (lookup && importLookup)` grava `lookup.address` como "Sede" e `lookup.email` e `lookup.phone` como contatos principais (`:81-90`), qualquer que seja o documento enviado em `body.document` (`:71`).
- O aviso "situação cadastral" (`:173-175`) e a caixa "Incluir endereço e contatos da consulta" (`:165-170`, marcada por padrão em `:38`) também continuam valendo para o CNPJ antigo. A caixa chega a aparecer para uma **pessoa**, depois de trocar o tipo.

### Verificação (tentativa de refutação)
- O servidor não compara o endereço com o CNPJ: `POST /api/entities/:id/addresses` aceita qualquer endereço.
- A caixa de marcar fica visível, mas não diz de qual CNPJ vieram os dados, então nada alerta o usuário que trocou o número.
- Não há teste do fluxo "consultar, trocar o documento, salvar".

### Impacto
Contato e endereço errados numa entidade nova, usados depois no PIX, em mensagens e em documentos. A chance é baixa, mas o erro fica silencioso.

## Como reproduzir
1. Entidades → Nova → Empresa. Digite o CNPJ A e clique em "Consultar CNPJ".
2. Troque o documento pelo CNPJ B e ajuste o nome à mão. Não consulte de novo.
3. Salve. A entidade B fica com o endereço "Sede" e os contatos de A.

## Solução proposta
Guardar na consulta o documento consultado (`lookup.document` ou um `lookedUp` com o `normalized` da hora) e importar só se ainda for igual ao documento atual e o tipo for `company`. Mais simples ainda: zerar `lookup` e `notice` no `onChange` do documento e ao trocar o tipo.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/components/entity/EntityFormModal.tsx
+++ b/apps/web/src/components/entity/EntityFormModal.tsx
@@
-                  onChange={(e) => setDocument(e.target.value.toUpperCase())}
+                  onChange={(e) => {
+                    setDocument(e.target.value.toUpperCase());
+                    setLookup(null);
+                    setNotice(null);
+                  }}
@@
-        if (lookup && importLookup) {
+        if (lookup && importLookup && kind === 'company') {
```
(e o mesmo `setLookup(null)` no botão de tipo.)

## Critérios de aceite
- [ ] Trocar o documento depois da consulta esconde a caixa "Incluir endereço e contatos" e não importa nada ao salvar.
- [ ] Trocar para Pessoa depois da consulta não importa nada.

## Testes recomendados
e2e com o CNPJ Aberto desligado e o fallback falso (ou `page.route('**/api/lookup/cnpj/*')`): consultar A, trocar para B, salvar e conferir na ficha que não há endereço "Sede".

## Limitações e suposições
Nada foi executado.

## Análise (triagem)

## Resolução (executor)
