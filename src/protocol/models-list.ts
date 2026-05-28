/**
 * Translates ModelRegistry.getAvailable() into the OpenAI /v1/models payload.
 *
 * id is always "provider/model-id" (Open WebUI / LiteLLM / OpenRouter
 * convention). owned_by is the provider. created is a stable per-process
 * timestamp so caching clients see consistent values.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

const PROCESS_START_TS = Math.floor(Date.now() / 1000);

export const OAUTH_SUBSCRIPTION_PROVIDERS = new Set([
  "anthropic",
  "claude-code",
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
]);

export interface ModelsListEntry {
  created: number;
  id: string;
  object: "model";
  owned_by: string;
}

export interface BuildModelsListOptions {
  allowlist?: string[];
  denylist?: string[];
  exposeOAuthSubscriptions: boolean;
  isLoopback: boolean;
  isUsingOAuth: (model: Model<Api>) => boolean;
  models: Model<Api>[];
}

export function buildModelsList(
  options: BuildModelsListOptions,
): ModelsListEntry[] {
  const allowSet = options.allowlist ? new Set(options.allowlist) : undefined;
  const denySet = options.denylist ? new Set(options.denylist) : undefined;

  const entries: ModelsListEntry[] = [];
  for (const model of options.models) {
    const compositeId = `${model.provider}/${model.id}`;
    if (allowSet && !allowSet.has(compositeId) && !allowSet.has(model.id)) {
      continue;
    }
    if (denySet && (denySet.has(compositeId) || denySet.has(model.id))) {
      continue;
    }
    const isSubscriptionProvider =
      OAUTH_SUBSCRIPTION_PROVIDERS.has(model.provider) ||
      options.isUsingOAuth(model);
    if (
      isSubscriptionProvider &&
      !options.isLoopback &&
      !options.exposeOAuthSubscriptions
    ) {
      continue;
    }
    entries.push({
      created: PROCESS_START_TS,
      id: compositeId,
      object: "model",
      owned_by: model.provider,
    });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

export function isOAuthSubscriptionProvider(provider: string): boolean {
  return OAUTH_SUBSCRIPTION_PROVIDERS.has(provider);
}
