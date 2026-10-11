import { anthropicClient } from './anthropic';
import { openaiClient } from './openai';
import type { LlmClient, LlmCredentials } from './types';

export { embedTexts } from './openai';
export * from './types';

/** Cliente do provedor. Testes podem trocar a fábrica (provedor falso via base_url já basta na maioria). */
export function createLlmClient(credentials: LlmCredentials): LlmClient {
  return credentials.kind === 'anthropic' ? anthropicClient(credentials) : openaiClient(credentials);
}
