import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/*
 * Cabeçalhos de segurança (tarefa 065, docs/001). Toda resposta leva X-Frame-Options,
 * X-Content-Type-Options e Referrer-Policy; o HTML do SPA leva também a CSP abaixo.
 * Uma resposta que já definiu a própria CSP (o sandbox dos downloads de anexo, tarefa 048)
 * fica com ela.
 */

/** Hashes (sha256, base64) dos `<script>` inline do index.html, para o `script-src`. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(match[1] ?? '')) continue;
    const body = match[2] ?? '';
    if (body.trim() === '') continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * CSP do SPA: scripts só da origem e o inline do tema (pelo hash); estilos da origem, do Google Fonts
 * e inline (atributos `style` do React e do markdown saneado); fontes do gstatic; imagens, áudio e o
 * worker do pdf.js da origem, com `blob:`/`data:` para as prévias, a gravação e as exportações.
 */
export function spaCsp(indexHtml: string): string {
  const scripts = ["'self'", ...inlineScriptHashes(indexHtml)].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** O hook dos cabeçalhos; `htmlCsp` = CSP das respostas HTML (null sem SPA servido). */
export function registerSecurityHeaders(app: FastifyInstance, htmlCsp: string | null) {
  // Sem SPA (dev, testes), o HTML que sair daqui ainda não entra em frame nem roda plugin.
  const csp = htmlCsp ?? "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html') && !reply.hasHeader('content-security-policy')) reply.header('content-security-policy', csp);
    return payload;
  });
}
