---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-11-21
commit:
---

# O markdown "seguro" aceita HTML cru: `<style>`, `style=`, formulários e `popover` mudam o console inteiro

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** injeção de CSS/HTML (UI redress) entre usuários e por prompt injection
- **Arquivos afetados:** `apps/web/src/agents/Markdown.tsx:15-27,52-61`, `apps/web/src/agents/ConversationPane.tsx:241,306,335`, `apps/web/src/agents/AttachmentPreview.tsx:321-377`, `apps/web/src/components/contracts/DocumentView.tsx:158-162,175-177`, `apps/web/src/components/notes/NoteModal.tsx:101,415-419`, `docs/020-contratos.md:35`
- **Depende de / relacionado a:** 065 (a CSP do SPA limita o estrago, mas não o impede)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O texto em markdown (resposta do agente, anotação global, documento do contrato, arquivo `.md` do chat) pode trazer HTML escondido. Esse HTML consegue cobrir a tela com uma página falsa ("sessão expirada, entre de novo"), esconder partes do cartão de aprovação do agente ou mudar o visual de qualquer tela, e isso aparece para outras pessoas que abrem o mesmo conteúdo.

### Evidência e análise técnica
- `Markdown.tsx:56-57`: `marked.parse(...)` e depois `DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })`. O marked não escapa HTML: conferido com um script descartável (marked 18.1.0), `<style>…</style>`, `<div style="position:fixed;inset:0;z-index:99">` e `<form><input type="password"><button>` saem intactos.
- O perfil `html` do DOMPurify 3.4.16 (lista em `node_modules/.pnpm/dompurify@3.4.16/.../purify.es.mjs`) permite as tags `style`, `form`, `input`, `button`, `textarea`, `select`, `dialog` e os atributos `style`, `class`, `id`, `popover`, `popovertarget`. Resultado: CSS global por `<style>` (vale para o documento inteiro, não só para `.agent-md`), sobreposição fixa por `style=` e camadas no *top layer* por `popover` (acima de modais e gavetas).
- O hook `afterSanitizeAttributes` (`Markdown.tsx:19-26`) é global no DOMPurify: qualquer outro uso futuro herda o `target=_blank`.
- Onde o mesmo renderizador mostra conteúdo de outra pessoa:
  - **anotação global** (`NoteModal.tsx:101` abre a nota existente já em "renderizado", `:415-419`): qualquer usuário cria; todos os outros leem (spec 035, linhas 26-29);
  - **documento markdown do contrato** (`DocumentView.tsx:158-162`): quem edita a caixa escreve, os leitores da caixa e o admin veem; a conversão PDF → markdown pela IA também grava nesse campo;
  - **anexo `.md` do chat** (`AttachmentPreview.tsx:371`): o admin abre a sessão de outro usuário em somente leitura;
  - **resposta do agente** (`ConversationPane.tsx:306`): o modelo pode ser induzido (prompt injection por descrição de linha de extrato, PDF lido, resultado de MCP) a devolver HTML, e o cartão de aprovação (`.agent-confirm`, `.agent-diff`) fica no mesmo documento, sujeito a CSS injetado.
- `docs/020-contratos.md:35` diz "o mesmo renderizador seguro do chat dos agentes, **sem HTML cru**". O código não cumpre.

### Verificação (tentativa de refutação)
- CSP da tarefa 065 (`apps/server/src/security-headers.ts`): `script-src` com hashes bloqueia JS; `img-src 'self' data: blob:`, `font-src` e `connect-src 'self'` bloqueiam exfiltração por CSS; `form-action 'self'` impede POST para fora. Mas `style-src 'self' 'unsafe-inline'` libera `<style>` e `style=`, então a sobreposição e a reestilização continuam. No `pnpm dev` (Vite) não há CSP nenhuma.
- Links `javascript:`/`data:` são barrados pelo `ALLOWED_URI_REGEXP` padrão; `//host` passa pelo hook sem `target`, mas o React Router 7.18.4 normaliza barras duplas no `navigate`, então não vira redirecionamento. Esses dois não são o problema.
- Um `<style>` no começo da string é movido para o `<head>` pelo parser e descartado; basta um texto antes dele (como no teste acima).
- Não há teste de sanitização no e2e (`rg "<style|<script|onerror" e2e` não acha nada) nem teste unitário no `apps/web`.

### Impacto
Usuário da mesma instalação (ou conteúdo externo lido pelo agente) consegue sobrepor uma tela falsa de login com link para fora, esconder o resumo/diff do cartão "Aplicar?" ou trocar o visual dos botões Aprovar/Recusar. Atinge todos que abrem a nota global, o documento do contrato ou a sessão (inclusive o admin).

## Como reproduzir
1. Usuário A (não admin) cria uma anotação **global** numa entidade com o corpo: `Aviso\n\n<div style="position:fixed;inset:0;z-index:2147483647;background:var(--bg)">Sessão expirada. <a href="https://exemplo.invalid">Entrar</a></div>`.
2. Usuário B abre a anotação em /notes: a janela abre em "renderizado" e a tela inteira vira a página falsa.
3. Variante: no documento markdown do contrato, `Texto\n\n<style>.agent-confirm-summary,.agent-diff{display:none}</style>` some com o resumo de qualquer cartão de aprovação aberto enquanto o documento está na tela.

## Solução proposta
1. Escapar o HTML no marked com uma instância própria (sem mexer no `marked` global):
   `const md = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => escapeHtml(text) } })`.
2. Sanear com lista explícita numa instância própria do DOMPurify (`DOMPurify(window)`), com o hook só nela:
   `ALLOWED_TAGS`: `p br strong em del code pre blockquote ul ol li h1-h6 hr table thead tbody tr th td a img input` (o `input` só para a lista de tarefas do GFM); `ALLOWED_ATTR`: `href title alt src colspan rowspan type checked disabled`; `FORBID_ATTR`: `style class id popover`; `ALLOWED_URI_REGEXP` só `https?:`, `mailto:`, `tel:` e caminho interno `/` (sem `//`).
3. Ajustar o comentário de `Markdown.tsx:9-12` e a spec 035 ("renderizador seguro, sem HTML cru"), alinhando com a 020.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/agents/Markdown.tsx
+++ b/apps/web/src/agents/Markdown.tsx
-import { marked } from 'marked';
+import { Marked } from 'marked';
+const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
+const md = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => escapeHtml(text) } });
+const purify = DOMPurify(window);
+const OPTIONS = { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...], FORBID_ATTR: ['style', 'class', 'id', 'popover'] };
@@
-    const raw = marked.parse(rewriteInternalLinks(text), { async: false, gfm: true, breaks: true }) as string;
-    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
+    const raw = md.parse(rewriteInternalLinks(text), { async: false }) as string;
+    return purify.sanitize(raw, OPTIONS);
```

## Critérios de aceite
- [ ] `<style>`, `style=`, `<form>`, `<input type=password>`, `<dialog>` e `popover` no markdown aparecem como texto escapado (ou somem), em todos os quatro usos.
- [ ] Negrito, listas, tabelas, código, links internos (`/entities/…`) e externos (`target=_blank`, `rel=noopener noreferrer`) continuam como hoje.
- [ ] A spec 035 e o comentário de `Markdown.tsx` dizem "sem HTML cru".

## Testes recomendados
- `e2e/tests/agentes.spec.ts`: o provedor falso (`e2e/fakes/fake-llm.ts`) responde com `Oi\n\n<style>body{display:none}</style><div style="position:fixed;inset:0">X</div>`; esperar o `body` visível, nenhum `style` dentro de `.agent-md` e o texto `<style>` escapado.
- `e2e/tests/anotacoes.spec.ts`: nota global com o corpo acima criada por um usuário e aberta por outro.
- Opcional: extrair `renderMarkdown(text)` para um módulo puro e testar com vitest + happy-dom (hoje o `apps/web` não tem runner de teste).

## Limitações e suposições
Nada foi executado no navegador; o comportamento do DOMPurify foi conferido pelas listas do pacote instalado, e o do marked por script. A severidade assume usuários da mesma instalação com papéis diferentes (família, empresa) e a CSP da produção como a da tarefa 065.

## Análise (triagem)

## Resolução (executor)
