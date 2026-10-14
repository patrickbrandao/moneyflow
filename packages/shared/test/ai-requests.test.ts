import { describe, expect, it } from 'vitest';
import { base64Extension, buildCurl, detectBase64, OMITTED_HEADER } from '../src';

describe('requisições ao provedor (spec 023)', () => {
  it('cURL: credenciais viram variáveis de ambiente, sem content-length; corpo com aspas escapadas', () => {
    const curl = buildCurl({
      method: 'post',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': OMITTED_HEADER,
        'anthropic-version': '2023-06-01',
        'content-length': '42',
        'content-type': 'application/json',
      },
      body: `{"text":"it's"}`,
      providerKind: 'anthropic',
    });
    expect(curl).toContain(`curl -X POST 'https://api.anthropic.com/v1/messages'`);
    expect(curl).toContain('-H "x-api-key: $ANTHROPIC_API_KEY"');
    expect(curl).toContain(`-H 'anthropic-version: 2023-06-01'`);
    expect(curl).not.toContain('content-length');
    expect(curl).toContain(`--data-raw '{"text":"it'\\''s"}'`);
    expect(curl).not.toContain(OMITTED_HEADER);
  });

  it('cURL sem cabeçalhos gravados: a chave do tipo do provedor e o content-type', () => {
    const curl = buildCurl({ method: 'GET', url: 'https://x.test/v1/models', headers: null, body: null, providerKind: 'openai' });
    expect(curl).toContain('-H "authorization: Bearer $OPENAI_API_KEY"');
    expect(curl).not.toContain('--data-raw');
  });

  it('base64: data URL com o tipo, base64 puro com o media_type do irmão, áudio pelo formato; texto comum não', () => {
    const raw = Buffer.alloc(300, 1).toString('base64');
    expect(detectBase64(`data:image/png;base64,${raw}`)).toMatchObject({ mime: 'image/png', kind: 'image', bytes: 300 });
    expect(detectBase64(raw, { type: 'base64', media_type: 'application/pdf' })).toMatchObject({ kind: 'pdf', bytes: 300 });
    expect(detectBase64(raw, { format: 'wav' })).toMatchObject({ mime: 'audio/wav', kind: 'audio' });
    expect(detectBase64(raw)).toMatchObject({ mime: null, kind: 'other' });
    expect(detectBase64('claude-sonnet-5-5')).toBeNull();
    expect(detectBase64('a'.repeat(255))).toBeNull();
    // Arquivo pequeno com o tipo declarado ao lado (source da Anthropic).
    expect(detectBase64('iVBORw0KGgo=', { type: 'base64', media_type: 'image/png' })).toMatchObject({ kind: 'image', bytes: 8 });
    expect(detectBase64('abcd1234', { type: 'text', media_type: 'text/plain' })).toBeNull();
    expect(detectBase64(`${'palavra '.repeat(50)}`)).toBeNull();
    expect(base64Extension('image/jpeg')).toBe('jpg');
    expect(base64Extension('audio/mpeg')).toBe('mp3');
    expect(base64Extension(null)).toBe('bin');
  });
});
