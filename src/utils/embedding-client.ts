/**
 * EmbeddingClient — Standalone utility for generating text embeddings.
 *
 * Wraps OpenAI-compatible embeddings.create() endpoint. Not an LLM provider —
 * embeddings are request/response, not streaming chat.
 *
 * Supports compound `provider/model` IDs (e.g. 'openrouter/text-embedding-3-small')
 * using the same provider → base URL / API key conventions as the LLM router.
 *
 * Gracefully degrades when no API key is set (available = false).
 */

import OpenAI from 'openai';
import { getLogger } from '../logger.js';
import { resolveBaseUrl } from './openai-compat.js';

const logger = getLogger().child({ component: 'embedding-client' });

export interface EmbeddingClientConfig {
  /** Model ID — plain ('text-embedding-3-small') or compound ('openrouter/text-embedding-3-small'). */
  model: string;
  /** Output dimensions (e.g. 1536 for text-embedding-3-small). */
  dimensions: number;
  /** Override API key (skips env var lookup). */
  apiKey?: string;
  /** Override base URL (skips provider default lookup). */
  baseUrl?: string;
}

export interface EmbeddingClient {
  /** Generate embeddings for one or more texts. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Embedding vector dimensions. */
  readonly dimensions: number;
  /** Whether the client has valid credentials and can make requests. */
  readonly available: boolean;
}

/**
 * Parse a compound `provider/model` ID. If there's no slash, defaults to
 * provider 'openai' for backward compatibility.
 */
function parseModelId(id: string): { provider: string; model: string } {
  const slashIdx = id.indexOf('/');
  if (slashIdx < 0) return { provider: 'openai', model: id };
  return { provider: id.slice(0, slashIdx), model: id.slice(slashIdx + 1) };
}

/**
 * Create an embedding client. Returns a client with available=false
 * when no API key is found — no throw, no crash, just graceful fallback.
 */
export function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient {
  const { provider, model } = parseModelId(config.model);

  // Resolve API key: explicit config > {PROVIDER}_API_KEY env var
  const envKeyName = `${provider.toUpperCase()}_API_KEY`;
  const apiKey = config.apiKey ?? process.env[envKeyName];

  if (!apiKey) {
    logger.debug('no_api_key', { provider, model, hint: `Set ${envKeyName} for embedding support` });
    return {
      async embed(): Promise<Float32Array[]> {
        throw new Error(`EmbeddingClient: ${envKeyName} not set`);
      },
      dimensions: config.dimensions,
      available: false,
    };
  }

  // Resolve base URL: explicit config > env override > known default > OpenAI fallback
  const baseURL = config.baseUrl ?? resolveBaseUrl(provider);
  const client = new OpenAI({ apiKey, baseURL });

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      logger.debug('embed_request', { provider, model, count: texts.length });

      const response = await client.embeddings.create({
        model,
        input: texts,
        dimensions: config.dimensions,
        encoding_format: 'float',
      });

      // Sort by index to match input order (API may return out of order)
      const sorted = response.data.sort((a, b) => a.index - b.index);

      return sorted.map(d => new Float32Array(d.embedding));
    },

    dimensions: config.dimensions,
    available: true,
  };
}
