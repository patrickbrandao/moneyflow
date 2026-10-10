import { type CepLookup, type CnpjLookup, normalizeCep, normalizeDocument, normalizeUf, t } from '@moneyflow/shared';
import { AppError } from '../errors';

/*
 * Autopreenchimento (spec 003): CNPJ na BrasilAPI e CEP no ViaCEP, com
 * timeout e falha graciosa — indisponível vira 503 com mensagem para
 * preencher à mão; inexistente vira 404.
 */

async function fetchJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    const body = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
    return { status: response.status, body };
  } catch {
    throw new AppError(503, 'lookup_unavailable', t.errors.lookupUnavailable);
  }
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export async function lookupCnpj(raw: string, timeoutMs: number): Promise<CnpjLookup> {
  const cnpj = normalizeDocument(raw);
  const { status, body } = await fetchJson(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, timeoutMs);
  if (status === 404 || status === 400) throw new AppError(404, 'lookup_not_found', t.errors.lookupNotFound);
  if (status !== 200 || !body || typeof body !== 'object') throw new AppError(503, 'lookup_unavailable', t.errors.lookupUnavailable);
  const data = body as Record<string, unknown>;
  const cep = normalizeCep(String(data.cep ?? ''));
  const uf = normalizeUf(String(data.uf ?? ''));
  const city = str(data.municipio);
  const phone = str(data.ddd_telefone_1);
  return {
    document: cnpj,
    name: str(data.razao_social) ?? '',
    tradeName: str(data.nome_fantasia),
    email: str(data.email)?.toLowerCase() ?? null,
    phone: phone ? phone.replace(/\D/g, '') : null,
    address:
      city && uf
        ? {
            postalCode: cep,
            street: [str(data.descricao_tipo_de_logradouro), str(data.logradouro)].filter(Boolean).join(' ') || null,
            number: str(data.numero),
            complement: str(data.complemento),
            district: str(data.bairro),
            city,
            state: uf,
          }
        : null,
  };
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
