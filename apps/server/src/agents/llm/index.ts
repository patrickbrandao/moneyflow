import { anthropicClient } from './anthropic';
import { openaiClient } from './openai';
import type { RequestLogBase } from './request-log';
import type { LlmClient, LlmCredentials } from './types';

export { embed, speak, type TranscribeResult, transcribe } from './openai';
export { type RequestLogBase, RequestRecorder } from './request-log';
export * from './types';

/**
 * Cliente do provedor. `log` diz a quem atribuir as requisições registradas
 * (spec 023: provedor, execução, usuário, log_bodies, tentativas); sem `db`,
 * as chamadas fazem as tentativas mas não são gravadas.
 */
export function createLlmClient(credentials: LlmCredentials, log: RequestLogBase = {}): LlmClient {
  return credentials.kind === 'anthropic' ? anthropicClient(credentials, log) : openaiClient(credentials, log);
}
