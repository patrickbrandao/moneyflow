import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inlineScriptHashes, registerSecurityHeaders, spaCsp } from '../src/security-headers';
import { type Harness, startApp } from './helpers';

/* Cabeçalhos de segurança e a CSP do SPA (tarefa 065). */

const THEME = "\n      (() => { document.documentElement.setAttribute('data-theme', 'dark'); })();\n    ";
const INDEX = `<!doctype html><html><head><script>${THEME}</script><script type="module" crossorigin src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`;

let dist: string;
let h: Harness;
beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'mf-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'index.js'), 'console.log(1)');
  h = await startApp({ WEB_DIST: dist });
});
afterAll(async () => {
  await h.close();
  rmSync(dist, { recursive: true, force: true });
});

const expectBase = (headers: Record<string, unknown>) => {
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
};

describe('cabeçalhos de segurança (tarefa 065)', () => {
  it('o hash do script inline do tema entra no script-src; o script com src não', () => {
    const expected = `'sha256-${createHash('sha256').update(THEME, 'utf8').digest('base64')}'`;
    expect(inlineScriptHashes(INDEX)).toEqual([expected]);
    const csp = spaCsp(INDEX);
    expect(csp).toContain(`script-src 'self' ${expected}`);
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain('unsafe-eval');
  });

  it('a API responde com os cabeçalhos, sem CSP no JSON', async () => {
    for (const url of ['/api/health', '/api/auth/me', '/api/nao-existe']) {
      const res = await h.app.inject({ method: 'GET', url });
      expectBase(res.headers);
      expect(res.headers['content-security-policy']).toBeUndefined();
    }
  });

  it('o HTML do SPA (raiz e rotas do console) leva a CSP; os assets não', async () => {
    for (const url of ['/', '/caixas/123/accounts', '/index.html']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expectBase(res.headers);
      expect(res.headers['content-security-policy']).toBe(spaCsp(INDEX));
    }
    const asset = await h.app.inject({ method: 'GET', url: '/assets/index.js' });
    expect(asset.statusCode).toBe(200);
    expectBase(asset.headers);
    expect(asset.headers['content-security-policy']).toBeUndefined();
  });

  it('sem SPA servido, um HTML sai com frame-ancestors, object-src e base-uri; a CSP própria da rota fica', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, null);
    app.get('/html', (_request, reply) => reply.type('text/html').send('<p>x</p>'));
    app.get('/sandbox', (_request, reply) => reply.type('text/html').header('content-security-policy', 'sandbox').send('<p>x</p>'));
    await app.ready();
    try {
      const html = await app.inject({ method: 'GET', url: '/html' });
      expectBase(html.headers);
      expect(html.headers['content-security-policy']).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      expect((await app.inject({ method: 'GET', url: '/sandbox' })).headers['content-security-policy']).toBe('sandbox');
    } finally {
      await app.close();
    }
  });
});

describe('id da requisição (tarefa 186)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('toda resposta leva x-request-id, um UUID diferente a cada requisição; sem TRUSTED_PROXIES o do cliente não vale', async () => {
    const ids = new Set<string>();
    for (const url of ['/api/health', '/api/auth/me', '/api/nao-existe', '/']) {
      const res = await h.app.inject({ method: 'GET', url, headers: { 'x-request-id': 'forjado-pelo-cliente-1' } });
      const id = String(res.headers['x-request-id']);
      expect(id, url).toMatch(UUID);
      ids.add(id);
    }
    expect(ids.size).toBe(4);
  });

  it('com TRUSTED_PROXIES, vale o id do proxy no formato certo; fora do formato, um UUID', async () => {
    const proxied = await startApp({ TRUSTED_PROXIES: '127.0.0.1' });
    try {
      const ok = await proxied.app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'proxy-abc_12345' } });
      expect(ok.headers['x-request-id']).toBe('proxy-abc_12345');
      const bad = await proxied.app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'ruim\ninjeta linha' } });
      expect(String(bad.headers['x-request-id'])).toMatch(UUID);
    } finally {
      await proxied.close();
    }
  });
});
