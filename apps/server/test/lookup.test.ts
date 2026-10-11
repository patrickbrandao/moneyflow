import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { client, type Harness, startApp, userSession } from './helpers';

/*
 * Consulta de CNPJ (spec 003): CNPJ Aberto com CNPJ_ABERTO_ENABLED e a chave,
 * BrasilAPI como padrão e fallback. Um servidor falso faz o papel dos dois
 * provedores (prefixos /ca e /ba); nada chama uma API real.
 */

const KEY = 'chave-falsa-de-teste';
const CNPJ = '41278833000104';

type Seen = { url: string; headers: IncomingHttpHeaders };
let seen: Seen[] = [];
/** Status que o CNPJ Aberto falso devolve no próximo pedido (200 = ficha). */
let abertoStatus = 200;

const abertoBody = {
  cnpj_basico: '41278833',
  razao_social: 'EMPRESA FICTICIA LTDA',
  estabelecimentos: [
    {
      cnpj: '41.278.833/0001-04',
      nome_fantasia: 'FICTICIA',
      situacao_cadastral: 'Inapta',
      tipo_logradouro: 'AVENIDA',
      logradouro: 'DAS FLORES',
      numero: '221',
      complemento: 'SALA 2',
      bairro: 'CENTRO',
      cep: '51160-330',
      uf: 'PE',
      municipio: 'RECIFE',
      telefone: '(81) 97723466',
      email: 'CONTATO@FICTICIA.TESTE',
    },
  ],
};

const brasilBody = {
  razao_social: 'EMPRESA FICTICIA LTDA (BRASILAPI)',
  nome_fantasia: '',
  descricao_situacao_cadastral: 'ATIVA',
  descricao_tipo_de_logradouro: 'AVENIDA',
  logradouro: 'DAS FLORES',
  numero: '221',
  bairro: 'CENTRO',
  cep: '51160330',
  uf: 'PE',
  municipio: 'RECIFE',
  ddd_telefone_1: '8197723466',
  email: null,
};

let fake: Server;
let base = '';
let h: Harness;
let cookie = '';

beforeAll(async () => {
  fake = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith('/ca/api/cnpj/')) {
      if (req.headers['x-api-key'] !== KEY) return json(401, { error: 'API Key inválida ou revogada.' });
      if (abertoStatus !== 200) return json(abertoStatus, { detail: 'erro' });
      return req.url.endsWith(`/${CNPJ}`) ? json(200, abertoBody) : json(404, { detail: 'CNPJ não encontrado' });
    }
    if (req.url?.startsWith('/ba/api/cnpj/v1/')) {
      return req.url.endsWith(`/${CNPJ}`) ? json(200, brasilBody) : json(404, { message: 'não encontrado' });
    }
    json(500, {});
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  h = await startApp({
    CNPJ_ABERTO_ENABLED: 'true',
    CNPJ_ABERTO_API_KEY: KEY,
    CNPJ_ABERTO_BASE: `${base}/ca`,
    BRASILAPI_BASE: `${base}/ba`,
  });
  cookie = (await userSession(h)).cookie;
});
afterAll(async () => {
  await h.close();
  await new Promise((resolve) => fake.close(resolve));
});
beforeEach(() => {
  seen = [];
  abertoStatus = 200;
});

describe('consulta de CNPJ', () => {
  it('com CNPJ_ABERTO_ENABLED consulta o CNPJ Aberto com X-API-Key e mapeia a ficha', async () => {
    const data = await client(h, cookie).get('/api/lookup/cnpj/41.278.833%2F0001-04');
    expect(data).toEqual({
      document: CNPJ,
      name: 'EMPRESA FICTICIA LTDA',
      tradeName: 'FICTICIA',
      email: 'contato@ficticia.teste',
      phone: '8197723466',
      registrationStatus: 'Inapta',
      source: 'cnpjaberto',
      address: {
        postalCode: '51160330',
        street: 'AVENIDA DAS FLORES',
        number: '221',
        complement: 'SALA 2',
        district: 'CENTRO',
        city: 'RECIFE',
        state: 'PE',
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-api-key']).toBe(KEY);
  });

  it('CNPJ inexistente no CNPJ Aberto é 404, sem cair na BrasilAPI', async () => {
    await client(h, cookie).get('/api/lookup/cnpj/11222333000181', 404);
    expect(seen.map((s) => s.url)).toEqual(['/ca/api/cnpj/11222333000181']);
  });

  it.each([401, 429, 500])('CNPJ Aberto com %i cai na BrasilAPI, sem expor a chave', async (status) => {
    abertoStatus = status;
    const res = await h.app.inject({ method: 'GET', url: `/api/lookup/cnpj/${CNPJ}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(KEY);
    expect(res.json()).toMatchObject({ source: 'brasilapi', name: 'EMPRESA FICTICIA LTDA (BRASILAPI)', registrationStatus: 'Ativa' });
    expect(seen.map((s) => s.url)).toEqual([`/ca/api/cnpj/${CNPJ}`, `/ba/api/cnpj/v1/${CNPJ}`]);
  });

  it('CNPJ alfanumérico vai direto à BrasilAPI', async () => {
    await client(h, cookie).get('/api/lookup/cnpj/12ABC34501DE35', 404);
    expect(seen.map((s) => s.url)).toEqual(['/ba/api/cnpj/v1/12ABC34501DE35']);
  });

  it('exige sessão', async () => {
    expect((await h.app.inject({ method: 'GET', url: `/api/lookup/cnpj/${CNPJ}` })).statusCode).toBe(401);
  });
});

describe('configuração do CNPJ Aberto', () => {
  const env = { DATABASE_URL: 'postgres://x' };
  it('desligado por padrão', () => {
    expect(loadConfig({ ...env, CNPJ_ABERTO_API_KEY: KEY }).cnpjAberto).toBeNull();
  });
  it('ligado sem chave falha na partida', () => {
    expect(() => loadConfig({ ...env, CNPJ_ABERTO_ENABLED: 'true' })).toThrow(/CNPJ_ABERTO_API_KEY/);
  });
  it('ligado com chave usa o endereço oficial', () => {
    expect(loadConfig({ ...env, CNPJ_ABERTO_ENABLED: 'true', CNPJ_ABERTO_API_KEY: KEY }).cnpjAberto).toEqual({
      base: 'https://cnpjaberto.com.br',
      apiKey: KEY,
    });
  });
});
