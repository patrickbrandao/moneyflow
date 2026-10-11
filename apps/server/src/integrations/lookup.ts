import { type CepLookup, type CnpjLookup, normalizeCep, normalizeDocument, normalizeUf, t } from '@moneyflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { AppError } from '../errors';

/*
 * Autopreenchimento (spec 003): CNPJ no CNPJ Aberto (com CNPJ_ABERTO_ENABLED e a
 * chave) ou na BrasilAPI, e CEP no ViaCEP, com timeout e falha graciosa —
 * indisponível vira 503 com mensagem para preencher à mão; inexistente vira 404.
 * Se o CNPJ Aberto falhar (rede, chave recusada, limite, 5xx), cai na BrasilAPI.
 */

type FetchResult = { status: number; body: unknown };

async function fetchJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<FetchResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...headers } });
    const body = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
    return { status: response.status, body };
  } catch {
    throw new AppError(503, 'lookup_unavailable', t.errors.lookupUnavailable);
  }
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const digits = (value: unknown) => str(value)?.replace(/\D/g, '') || null;
/** "ATIVA" (BrasilAPI) e "Ativa" (CNPJ Aberto) viram "Ativa". */
const situation = (value: unknown) => {
  const s = str(value);
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null;
};

function address(raw: {
  cep: unknown;
  uf: unknown;
  city: unknown;
  streetType: unknown;
  street: unknown;
  number: unknown;
  complement: unknown;
  district: unknown;
}) {
  const uf = normalizeUf(String(raw.uf ?? ''));
  const city = str(raw.city);
  if (!city || !uf) return null;
  return {
    postalCode: normalizeCep(String(raw.cep ?? '')),
    street: [str(raw.streetType), str(raw.street)].filter(Boolean).join(' ') || null,
    number: str(raw.number),
    complement: str(raw.complement),
    district: str(raw.district),
    city,
    state: uf,
  };
}

/** Falha do provedor (não "inexistente"): rede, chave recusada (401), limite (429) ou erro do servidor. */
class ProviderDown extends Error {
  constructor(readonly status: number | null) {
    super(`provedor indisponível (${status ?? 'rede'})`);
  }
}

function notFoundOrDown({ status, body }: FetchResult): Record<string, unknown> {
  if (status === 404 || status === 400) throw new AppError(404, 'lookup_not_found', t.errors.lookupNotFound);
  if (status !== 200 || !body || typeof body !== 'object') throw new ProviderDown(status);
  return body as Record<string, unknown>;
}

async function fromCnpjAberto(cnpj: string, base: string, apiKey: string, timeoutMs: number): Promise<CnpjLookup> {
  let result: FetchResult;
  try {
    result = await fetchJson(`${base}/api/cnpj/${cnpj}`, timeoutMs, { 'x-api-key': apiKey });
  } catch {
    throw new ProviderDown(null);
  }
  const data = notFoundOrDown(result);
  const branches = Array.isArray(data.estabelecimentos) ? (data.estabelecimentos as Record<string, unknown>[]) : [];
  // O estabelecimento devolvido é o do CNPJ pedido (matriz ou filial); confere pelo número.
  const branch = branches.find((b) => digits(b.cnpj) === cnpj) ?? branches[0] ?? {};
  return {
    document: cnpj,
    name: str(data.razao_social) ?? '',
    tradeName: str(branch.nome_fantasia),
    email: str(branch.email)?.toLowerCase() ?? null,
    phone: digits(branch.telefone),
    registrationStatus: situation(branch.situacao_cadastral),
    source: 'cnpjaberto',
    address: address({
      cep: branch.cep,
      uf: branch.uf,
      city: branch.municipio,
      streetType: branch.tipo_logradouro,
      street: branch.logradouro,
      number: branch.numero,
      complement: branch.complemento,
      district: branch.bairro,
    }),
  };
}

async function fromBrasilApi(cnpj: string, base: string, timeoutMs: number): Promise<CnpjLookup> {
  let data: Record<string, unknown>;
  try {
    data = notFoundOrDown(await fetchJson(`${base}/api/cnpj/v1/${cnpj}`, timeoutMs));
  } catch (error) {
    if (error instanceof ProviderDown) throw new AppError(503, 'lookup_unavailable', t.errors.lookupUnavailable);
    throw error;
  }
  return {
    document: cnpj,
    name: str(data.razao_social) ?? '',
    tradeName: str(data.nome_fantasia),
    email: str(data.email)?.toLowerCase() ?? null,
    phone: digits(data.ddd_telefone_1),
    registrationStatus: situation(data.descricao_situacao_cadastral),
    source: 'brasilapi',
    address: address({
      cep: data.cep,
      uf: data.uf,
      city: data.municipio,
      streetType: data.descricao_tipo_de_logradouro,
      street: data.logradouro,
      number: data.numero,
      complement: data.complemento,
      district: data.bairro,
    }),
  };
}

type CnpjLookupConfig = Pick<Config, 'lookupTimeoutMs' | 'cnpjAberto' | 'brasilApiBase'>;

export async function lookupCnpj(raw: string, config: CnpjLookupConfig, log?: FastifyBaseLogger): Promise<CnpjLookup> {
  const cnpj = normalizeDocument(raw);
  // O CNPJ Aberto só aceita os 14 dígitos; o alfanumérico vai direto à BrasilAPI.
  if (config.cnpjAberto && /^\d{14}$/.test(cnpj)) {
    try {
      return await fromCnpjAberto(cnpj, config.cnpjAberto.base, config.cnpjAberto.apiKey, config.lookupTimeoutMs);
    } catch (error) {
      if (!(error instanceof ProviderDown)) throw error;
      // Nunca loga a chave nem a URL com cabeçalhos; só o status.
      log?.warn({ status: error.status }, 'CNPJ Aberto indisponível; consultando a BrasilAPI');
    }
  }
  return fromBrasilApi(cnpj, config.brasilApiBase, config.lookupTimeoutMs);
}

export async function lookupCep(raw: string, timeoutMs: number): Promise<CepLookup> {
  const cep = normalizeCep(raw);
  if (!cep) throw new AppError(400, 'validation', t.errors.invalidCep);
  const { status, body } = await fetchJson(`https://viacep.com.br/ws/${cep}/json/`, timeoutMs);
  if (status === 400) throw new AppError(404, 'lookup_not_found', t.errors.lookupNotFound);
  if (status !== 200 || !body || typeof body !== 'object') throw new AppError(503, 'lookup_unavailable', t.errors.lookupUnavailable);
  const data = body as Record<string, unknown>;
  if (data.erro) throw new AppError(404, 'lookup_not_found', t.errors.lookupNotFound);
  return {
    postalCode: cep,
    street: str(data.logradouro),
    complement: str(data.complemento),
    district: str(data.bairro),
    city: str(data.localidade) ?? '',
    state: normalizeUf(String(data.uf ?? '')) ?? '',
  };
}
