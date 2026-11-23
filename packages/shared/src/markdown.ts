/*
 * Política do markdown seguro do console (chat dos agentes, anotações,
 * documentos de contrato e anexos .md; specs 020, 025 e 035): sem HTML cru.
 * O renderizador (apps/web/src/agents/Markdown.tsx) escapa todo HTML do texto
 * no marked (o `escapeHtml` de messages.ts) e saneia a saída numa instância
 * própria do DOMPurify com as listas abaixo, de modo que nem `<style>`,
 * `style=`, formulários, `<dialog>` ou `popover` chegam ao documento.
 */

/** Só as tags que o próprio markdown (GFM) produz; o `input` é o da lista de tarefas. */
export const MARKDOWN_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'input',
] as const;

/** Atributos que o markdown produz (link, imagem, tabela, lista numerada e caixa de tarefa). */
export const MARKDOWN_ALLOWED_ATTR = [
  'href',
  'title',
  'alt',
  'src',
  'align',
  'start',
  'colspan',
  'rowspan',
  'type',
  'checked',
  'disabled',
] as const;

/** Barrados explicitamente, mesmo que uma lista acima mude: reestilizar ou pôr camadas sobre o console. */
export const MARKDOWN_FORBID_ATTR = [
  'style',
  'class',
  'id',
  'popover',
  'popovertarget',
  'popovertargetaction',
  'form',
  'formaction',
] as const;

/**
 * Endereços aceitos em `href`/`src`: http(s), mailto, tel e caminho interno
 * (`/entities/…`). Nunca `//host` nem `/\host`, que o navegador trata como
 * outro site.
 */
export const MARKDOWN_SAFE_URI = /^(?:(?:https?|mailto|tel):|\/(?![/\\]))/i;

/** Os brancos que o DOMPurify (e o navegador) descartam antes de interpretar a URL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a mesma faixa de controle que o DOMPurify remove (ATTR_WHITESPACE).
const URI_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

/** A mesma checagem do DOMPurify com `MARKDOWN_SAFE_URI`: brancos removidos antes do teste. */
export function isSafeMarkdownUri(value: string): boolean {
  return MARKDOWN_SAFE_URI.test(value.replace(URI_WHITESPACE, ''));
}

/** Link interno do console: navega pelo router, sem abrir outra aba. */
export function isInternalHref(href: string): boolean {
  return href.startsWith('/') && isSafeMarkdownUri(href);
}

/** Referências que o console entende: "(entity:<id>)" → rota interna. */
const INTERNAL: Record<string, (id: string) => string> = {
  entity: (id) => `/entities/${id}`,
  caixa: (id) => `/caixas/${id}`,
  invoice: (id) => `/card-invoices/${id}`,
};

/** Troca "](entity:<uuid>)" e afins pelo caminho da tela do registro. */
export function rewriteInternalLinks(markdown: string): string {
  return markdown.replace(/\]\((entity|caixa|invoice):([0-9a-f-]{36})\)/gi, (_all, kind: string, id: string) => {
    const to = INTERNAL[kind.toLowerCase()];
    return to ? `](${to(id)})` : `](${kind}:${id})`;
  });
}
