---
name: ax-onboarding
description: Use when modifying the first-run setup, configuration wizard, bootstrap ritual, or profile defaults in src/onboarding/ and src/cli/bootstrap.ts
---

## Overview

The onboarding system handles first-run configuration (interactive or programmatic), generates `ax.yaml` and `.env` files based on security profile selection, and manages the bootstrap ritual for agent identity discovery. It also supports reconfiguration by reading existing settings as defaults.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/onboarding/wizard.ts` | Config generation (programmatic + interactive) | `runOnboarding()`, `loadExistingConfig()` |
| `src/onboarding/prompts.ts` | Profile defaults, agent types, provider choices, image provider info | `PROFILE_DEFAULTS`, `AGENT_TYPES`, `PROVIDER_CHOICES`, `IMAGE_PROVIDERS`, `DEFAULT_IMAGE_MODELS` |
| `src/onboarding/configure.ts` | Interactive @inquirer/prompts wizard, UI helpers | `runConfigure()`, `buildInquirerDefaults()` |
| `src/cli/bootstrap.ts` | Agent identity reset ritual | `resetAgent()` |

## Programmatic Onboarding

`runOnboarding(opts)` generates config files from `OnboardingAnswers`:

```typescript
interface OnboardingAnswers {
  profile: 'paranoid' | 'balanced' | 'yolo';
  agent?: string;                    // Agent type: 'pi-coding-agent' | 'claude-code'
  apiKey?: string;                   // Anthropic API key
  oauthToken?: string;               // OAuth token (alternative to API key)
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
  channels: string[];                // ['cli', 'slack', ...]
  skipSkills: boolean;
  installSkills?: string[];          // Skill names for .clawhub-install-queue
  credsPassphrase?: string;          // For encrypted credential provider
  webSearchApiKey?: string;          // Tavily API key
  slackBotToken?: string;
  slackAppToken?: string;
  imageModel?: string;               // Image generation model (e.g., 'openai/dall-e-3')
}
```

**Output files:**
- `ax.yaml` -- Full config with providers, sandbox, scheduler, channel_config, models (including models.image if imageModel set)
- `.env` -- API keys, OAuth tokens, passphrases (never in ax.yaml)
- `.clawhub-install-queue` -- Optional skill install list

## Profile Defaults

`PROFILE_DEFAULTS` in `prompts.ts` maps each profile to provider selections:

| Provider | Paranoid | Balanced | Yolo |
|---|---|---|---|
| agent | pi-coding-agent | pi-coding-agent | pi-coding-agent |
| memory | file | sqlite | sqlite |
| scanner | patterns | patterns | basic |
| web | none | fetch | fetch |
| browser | none | none | container |
| credentials | env | env | encrypted |
| skills | readonly | git | git |
| audit | file | sqlite | sqlite |
| sandbox | seatbelt/nsjail | seatbelt/nsjail | subprocess |
| scheduler | none | cron | cron |

## Agent Types

- **`pi-coding-agent`** -- Default. Uses pi-coding-agent library with proxy or IPC LLM transport.
- **`claude-code`** -- Uses Claude Agent SDK with TCP bridge + MCP tools. Models optional (relies on agent-internal logic).

## Image Provider Support

The wizard now includes image generation configuration:
- **Image providers**: openai (DALL-E), openrouter, gemini, groq, and more
- **`DEFAULT_IMAGE_MODELS`**: Maps providers to default model IDs
- **Config output**: Writes `models.image` array in `ax.yaml` when imageModel is specified

## Interactive Configuration

`runConfigure()` uses @inquirer/prompts:
1. Profile selection (paranoid/balanced/yolo)
2. Agent type selection (pi-coding-agent/claude-code)
3. Auth method (API key or OAuth)
4. API key / OAuth token input
5. Channel selection (multi-select)
6. Channel-specific tokens (Slack bot/app tokens)
7. Image generation toggle + provider/model selection
8. Additional provider settings (Tavily key, passphrase)

## Common Tasks

**Adding a new security profile:**
1. Add profile entry to `PROFILE_DEFAULTS` in `prompts.ts`
2. Add profile choice to interactive wizard in `configure.ts`
3. Update taint threshold in `src/host/taint-budget.ts`
4. Add test in `tests/onboarding/wizard.test.ts`

**Adding a new channel to onboarding:**
1. Add to `PROVIDER_CHOICES.channels` in `prompts.ts`
2. Add channel-specific token prompts in `configure.ts`
3. Add `.env` writing logic in `wizard.ts` for the channel's tokens
4. Add `channel_config` generation for the channel
5. Add `loadExistingConfig` reading for the channel's tokens

**Adding a new image provider:**
1. Add to `IMAGE_PROVIDERS` array in `prompts.ts`
2. Add display name to `IMAGE_PROVIDER_DISPLAY_NAMES`
3. Add default model to `DEFAULT_IMAGE_MODELS`
4. Add provider implementation in `src/providers/image/<name>.ts`
5. Register in `src/host/provider-map.ts`

## Gotchas

- **`.env` never goes in ax.yaml**: Secrets go in `.env` only. The wizard enforces this separation.
- **'cli' is stripped from channels on load**: `loadExistingConfig` removes 'cli' since it's always implicit.
- **OAuth vs API key detection**: `loadExistingConfig` checks for `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.
- **`skipSkills: true` suppresses .clawhub-install-queue**: Even if `installSkills` is provided.
- **Bootstrap preserves per-user state**: `resetAgent` keeps `users/` directory.
- **Models are task-type keyed**: Config writes `models.default` (LLM) and `models.image` (image generation) as separate arrays.
- **claude-code models optional**: claude-code agents can omit `models.default` entirely.
- **Channel config is per-profile**: Different profiles may want different channel defaults.
