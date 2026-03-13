---
name: provider-image
description: Use when modifying image generation providers — Gemini, OpenAI, OpenRouter, router fallback logic, or image model routing in src/providers/image/
---

## Overview

Text-to-image generation with fallback routing. The router loads child providers from `config.models.image` and tries them sequentially with per-provider exponential backoff cooldowns. Supports input images (edit/variation) where the provider allows it.

## Interface (`src/providers/image/types.ts`)

### ImageGenerateRequest

| Field        | Type                                  | Required | Notes                          |
|--------------|---------------------------------------|----------|--------------------------------|
| `prompt`     | `string`                              | yes      | Text description               |
| `model`      | `string`                              | yes      | Model identifier               |
| `inputImage` | `{ data: Buffer; mimeType: string }`  | no       | For edits/variations           |
| `size`       | `string`                              | no       | e.g. `1024x1024`              |
| `quality`    | `string`                              | no       | e.g. `hd`                     |

### ImageGenerateResult

| Field      | Type     | Required | Notes                          |
|------------|----------|----------|--------------------------------|
| `image`    | `Buffer` | yes      | Raw image data                 |
| `mimeType` | `string` | yes      | e.g. `image/png`              |
| `text`     | `string` | no       | Caption (e.g. Gemini)          |
| `model`    | `string` | yes      | Model that generated it        |

### ImageProvider

| Method                     | Description                              |
|----------------------------|------------------------------------------|
| `name`                     | Provider identifier (read-only)          |
| `generate(req)`            | Generate an image from request           |
| `models()`                 | List available model names               |

## Implementations

| Provider       | File                | API                | Notes                                          |
|----------------|---------------------|--------------------|-------------------------------------------------|
| `openai`       | `openai-images.ts`  | OpenAI Images API  | DALL-E, also used for Groq/Seedream             |
| `openrouter`   | `openrouter.ts`     | OpenRouter         | Wrapper for OpenRouter image models             |
| `gemini`       | `gemini.ts`         | Google Gemini      | Uses `responseModalities: ["TEXT", "IMAGE"]`; supports input images |
| `router`       | `router.ts`         | Multi-provider     | Dispatches across providers with backoff        |
| `mock`         | `mock.ts`           | None               | Returns 1x1 transparent PNG for testing         |

Provider map entries in `src/host/provider-map.ts`:
```
image: {
  openai:     '../providers/image/openai-images.js',
  openrouter: '../providers/image/openrouter.js',
  groq:       '../providers/image/openai-images.js',
  gemini:     '../providers/image/gemini.js',
  router:     '../providers/image/router.js',
  mock:       '../providers/image/mock.js',
}
```

## Router Details

- Parses `provider/model` compound IDs from `config.models.image`.
- Tries providers sequentially; on failure, applies per-provider exponential backoff (30s → 5min).
- Cooldown is per-provider, not per-model — all models from one provider share one cooldown.
- `isRetryable()` classifies 401/403/400/404 as non-retryable (permanent fail, no cooldown applied).
- Requires `config.models.image` to be a non-empty array.

## Provider-Specific Details

**Gemini**: Base64 data extracted from `inlineData.data` (not `inline_data`); mimeType from `inlineData.mimeType`. Supports input images for editing.

**OpenAI Images**: Returns either `b64_json` or `url`; must handle both cases, fetching URL if present. Also used for Groq (same OpenAI-compatible endpoint).

## Common Tasks

**Adding a new image provider:**
1. Create `src/providers/image/<name>.ts` implementing `ImageProvider`.
2. Export `create(config: Config)`.
3. Add entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/image/<name>.test.ts`.

**Adding a new image model to an existing provider:**
- Add the `provider/model` string to `config.models.image` in the config. The router picks it up automatically.

## Gotchas

- **Compound model IDs**: The router splits on `/` to resolve `provider/model`. Provider name must match a provider-map key.
- **Per-provider cooldown**: All Gemini models share one cooldown. A failure on `gemini/model-a` cools down `gemini/model-b` too.
- **OpenAI returns b64 or URL**: Always handle both `b64_json` and `url` response formats.
- **Gemini field names**: Use `inlineData.data`, not `inline_data.data` (camelCase, not snake_case).
- **Non-retryable errors skip cooldown**: 4xx auth/client errors don't trigger backoff — they fail immediately.

## Key Files

- `src/providers/image/types.ts` — Interface definitions
- `src/providers/image/router.ts` — Multi-provider fallback router
- `src/providers/image/gemini.ts` — Google Gemini implementation
- `src/providers/image/openai-images.ts` — OpenAI/Groq implementation
- `src/providers/image/openrouter.ts` — OpenRouter implementation
- `src/providers/image/mock.ts` — Test mock
- `tests/providers/image/router.test.ts`
- `tests/providers/image/openrouter.test.ts`
