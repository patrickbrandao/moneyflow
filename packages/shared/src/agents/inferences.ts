import { AI_INFERENCE_CAPABILITIES } from './schemas';
import type { AiCapability, AiInferenceCapability } from './types';

/*
 * "Provedor padrão" do agente (spec 024): escolhido no formulário, preenche o
 * provedor de texto e as inferências que ele suporta (visão, embeddings,
 * áudio→texto, texto→áudio). Cada uma pode ser trocada depois; modelo e voz
 * nulos herdam os padrões do provedor.
 */
export type InferenceChoice = { capability: AiInferenceCapability; providerId: string; model: string | null; voice: string | null };

export function inferencesFromProvider(provider: { id: string; capabilities: readonly AiCapability[] }): {
  providerId: string | null;
  inferences: InferenceChoice[];
} {
  return {
    providerId: provider.capabilities.includes('text') ? provider.id : null,
    inferences: AI_INFERENCE_CAPABILITIES.filter((c) => provider.capabilities.includes(c)).map((capability) => ({
      capability,
      providerId: provider.id,
      model: null,
      voice: null,
    })),
  };
}
