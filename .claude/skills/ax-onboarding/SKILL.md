---
name: ax-onboarding
description: Use when modifying the first-run setup, configuration wizard, bootstrap ritual, or profile defaults in src/onboarding/ and src/cli/bootstrap.ts
---

## Overview

The onboarding system handles first-run configuration via a minimal 3-question wizard (profile → LLM provider → API key), generates a minimal `ax.yaml`, and stores credentials directly in the SQLite database. It also supports reconfiguration.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/onboarding/wizard.ts` | Config generation, minimal ax.yaml + database credential storage | `runOnboarding()`, `loadExistingConfig()`, `openCredentialStore()` |
| `src/onboarding/prompts.ts` | Profile names, LLM providers, default models | `PROFILE_NAMES`, `PROFILE_DISPLAY_NAMES`, `LLM_PROVIDERS`, `DEFAULT_MODELS` |
| `src/onboarding/configure.ts` | Interactive @inquirer/prompts 3-question wizard | `runConfigure()` |
| `src/cli/bootstrap.ts` | Agent identity reset ritual | `resetAgent()` |

## Programmatic Onboarding

`runOnboarding(opts)` generates config files from `OnboardingAnswers`:

```typescript
interface OnboardingAnswers {
  profile: 'paranoid' | 'balanced' | 'yolo';
  llmProvider?: string;     // anthropic, openai, openrouter, groq, deepinfra
  model?: string;           // Model name (provider-specific default)
  apiKey?: string;          // LLM API key
}
```

**Output files:**
- `ax.yaml` -- Minimal config (profile + models.default only, all other fields use Zod schema defaults)
- Credentials stored directly in SQLite database (`~/.ax/data/ax.db`) via `openCredentialStore()`

## Interactive Configuration

`runConfigure()` uses @inquirer/prompts:
1. Profile selection (paranoid/balanced/yolo)
2. LLM provider selection (anthropic/openai/openrouter/groq/deepinfra)
3. Model name input (with provider-specific default)
4. API key input (password field, masked)

## Common Tasks

**Adding a new security profile:**
1. Add profile to `PROFILE_NAMES` in `prompts.ts`
2. Add display name to `PROFILE_DISPLAY_NAMES` in `prompts.ts`
3. Add profile choice to interactive wizard in `configure.ts`
4. Add default values in `config.ts` Zod schema
5. Add test in `tests/onboarding/wizard.test.ts`

**Adding a new LLM provider to onboarding:**
1. Add to `LLM_PROVIDERS` array in `prompts.ts`
2. Add default model to `DEFAULT_MODELS`
3. Add provider implementation in `src/providers/llm/<name>.ts`
4. Register in `src/host/provider-map.ts`

## Gotchas

- **Credentials stored in database, not .env file.** The wizard opens SQLite directly via `openCredentialStore()`.
- **Reconfigure flow loads existing API key from database and shows masked version as default.**
- **Provider defaults live in config.ts Zod schema, not in PROFILE_DEFAULTS.** The wizard only writes profile and models.default to ax.yaml.
- **Bootstrap preserves per-user state**: `resetAgent` keeps `users/` directory.
- **claude-code models optional**: claude-code agents can omit `models.default` entirely.
- **Channel config is per-profile**: Different profiles may want different channel defaults.
