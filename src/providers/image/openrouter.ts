/**
 * OpenRouter image generation provider.
 *
 * OpenRouter exposes image generation through the standard /chat/completions
 * endpoint using the `modalities` parameter, NOT /images/generations.
 *
 * Request: POST /api/v1/chat/completions with modalities: ["image", "text"]
 * Response: choices[0].message.images[0].image_url.url → data:image/png;base64,...
 */

import type { ImageProvider, ImageGenerateRequest, ImageGenerateResult } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';
import { resolveBaseUrl } from '../../utils/openai-compat.js';

const logger = getLogger().child({ component: 'openrouter-images' });

export async function create(config: Config, providerName?: string): Promise<ImageProvider> {
  const name = providerName || 'openrouter';
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return {
      name,
      async generate(): Promise<ImageGenerateResult> {
        throw new Error(
          'OPENROUTER_API_KEY environment variable is required.\n' +
          'Set it with: export OPENROUTER_API_KEY=your-api-key',
        );
      },
      async models() { return []; },
    };
  }

  const baseURL = resolveBaseUrl('openrouter');

  logger.debug('create', { provider: name, baseURL });

  return {
    name,

    async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
      logger.debug('generate_start', { provider: name, model: req.model });

      const body: Record<string, unknown> = {
        model: req.model,
        messages: [{ role: 'user', content: req.prompt }],
        modalities: ['image', 'text'],
      };

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter image generation failed (${response.status}): ${text}`);
      }

      const json = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            images?: Array<{
              type: string;
              image_url: { url: string };
            }>;
          };
        }>;
      };

      const message = json.choices?.[0]?.message;
      const imageEntry = message?.images?.[0];

      if (!imageEntry?.image_url?.url) {
        throw new Error('OpenRouter returned no image data in response');
      }

      // Parse data URL: "data:image/png;base64,iVBORw0KGgo..."
      const dataUrl = imageEntry.image_url.url;
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error('OpenRouter returned image in unexpected format (expected base64 data URL)');
      }

      const mimeType = match[1];
      const imageBuffer = Buffer.from(match[2], 'base64');

      logger.debug('generate_done', { provider: name, model: req.model, bytes: imageBuffer.length, mimeType });

      return {
        image: imageBuffer,
        mimeType,
        text: message?.content || undefined,
        model: req.model,
      };
    },

    async models(): Promise<string[]> {
      return [];
    },
  };
}
