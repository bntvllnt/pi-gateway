/**
 * Parses OpenAI-shaped `model` strings against pi's ModelRegistry.
 *
 * Accepted forms:
 *   - "provider/model-id"  → exact match (Open WebUI / LiteLLM / OpenRouter convention)
 *   - "model-id"           → first available match across all providers
 *   - "provider/model-id:thinking" → currently treated identically to "provider/model-id"
 *
 * Returns the resolved pi-ai Model, or `null` if the id is unknown / ambiguous.
 */
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

export interface ParsedModelId {
  modelId: string;
  provider?: string;
  raw: string;
  thinkingLevel?: string;
}

export function parseModelId(input: string): ParsedModelId {
  const raw = input.trim();
  let provider: string | undefined;
  let modelId = raw;
  let thinkingLevel: string | undefined;

  const colonIndex = modelId.lastIndexOf(":");
  if (colonIndex !== -1) {
    thinkingLevel = modelId.slice(colonIndex + 1) || undefined;
    modelId = modelId.slice(0, colonIndex);
  }

  const slashIndex = modelId.indexOf("/");
  if (slashIndex !== -1) {
    provider = modelId.slice(0, slashIndex);
    modelId = modelId.slice(slashIndex + 1);
  }

  return { modelId, provider, raw, thinkingLevel };
}

export function resolveModel(
  registry: ModelRegistry,
  input: string,
): Model<Api> | null {
  const parsed = parseModelId(input);
  if (parsed.provider) {
    return registry.find(parsed.provider, parsed.modelId) ?? null;
  }
  const available = registry.getAvailable();
  const matches = available.filter((m) => m.id === parsed.modelId);
  if (matches.length === 0) return null;
  return matches[0]!;
}
