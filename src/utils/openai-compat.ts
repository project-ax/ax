/**
 * Shared constants and helpers for OpenAI-compatible providers.
 *
 * Every provider that speaks the OpenAI wire format (LLM, image, embeddings)
 * should pull its base URLs and env-var helpers from here instead of
 * maintaining its own copy.
 */

/** Default base URLs for known OpenAI-compatible providers. */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
};

/** Derive the API-key env var name from a provider name (e.g. 'groq' → 'GROQ_API_KEY'). */
export function envKey(providerName: string): string {
  return `${providerName.toUpperCase()}_API_KEY`;
}

/** Derive the base-URL env var name from a provider name (e.g. 'groq' → 'GROQ_BASE_URL'). */
export function envBaseUrl(providerName: string): string {
  return `${providerName.toUpperCase()}_BASE_URL`;
}

/** Resolve the base URL for a provider: explicit env override → known default → OpenAI fallback. */
export function resolveBaseUrl(providerName: string): string {
  return process.env[envBaseUrl(providerName)]
    || DEFAULT_BASE_URLS[providerName]
    || 'https://api.openai.com/v1';
}
