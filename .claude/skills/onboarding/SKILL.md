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
| `src/onboarding/prompts.ts` | Profile defaults, agent types, provider choices | `PROFILE_DEFAULTS`, `AGENT_TYPES`, `PROVIDER_CHOICES` |
| `src/onboarding/configure.ts` | Interactive @inquirer/prompts wizard, UI helpers | `runConfigure()`, `buildInquirerDefaults()` |
| `src/cli/bootstrap.ts` | Agent identity reset ritual | `resetAgent()` |

## Programmatic Onboarding

`runOnboarding(opts)` generates config files from `OnboardingAnswers`:

```typescript
interface OnboardingAnswers {
  profile: 'paranoid' | 'balanced' | 'yolo';
  agent?: string;                    // Agent type (defaults to profile default)
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
}
```

**Output files:**
- `ax.yaml` — Full config with providers, sandbox, scheduler, channel_config sections
- `.env` — API keys, OAuth tokens, passphrases (never in ax.yaml)
- `.clawhub-install-queue` — Optional skill install list

## Profile Defaults

`PROFILE_DEFAULTS` in `prompts.ts` maps each profile to provider selections:

| Provider | Paranoid | Balanced | Yolo |
|---|---|---|---|
| agent | pi-agent-core | pi-agent-core | pi-agent-core |
| llm | anthropic | anthropic | anthropic |
| memory | file | sqlite | sqlite |
| scanner | patterns | patterns | basic |
| web | none | fetch | fetch |
| browser | none | none | container |
| credentials | env | env | encrypted |
| skills | readonly | git | git |
| audit | file | sqlite | sqlite |
| sandbox | seatbelt/nsjail | seatbelt/nsjail | subprocess |
| scheduler | none | cron | cron |

## Interactive Configuration

`runConfigure()` uses @inquirer/prompts for terminal UI:
1. Profile selection (paranoid/balanced/yolo)
2. Agent type selection
3. Auth method (API key or OAuth)
4. API key / OAuth token input
5. Channel selection (multi-select)
6. Channel-specific tokens (Slack bot/app tokens)
7. Additional provider settings (Tavily key, passphrase)

`buildInquirerDefaults(existing)` maps existing config to pre-filled defaults for reconfiguration. Masks API keys for display (e.g., `sk-...5678`).

## Reconfiguration

`loadExistingConfig(dir)` reads `ax.yaml` + `.env` and returns `OnboardingAnswers | null`:
- Reads profile, agent, provider selections from ax.yaml
- Reads API keys, OAuth tokens, passphrases from .env
- Detects auth method (api-key vs oauth) based on which tokens are present
- Strips 'cli' from channels (always implicit)
- Returns `null` if no config exists

## Bootstrap Ritual

`resetAgent(agentDir, templatesDir)` in `src/cli/bootstrap.ts`:

1. Deletes evolvable identity files: `SOUL.md`, `IDENTITY.md`, old `BOOTSTRAP.md`
2. Copies fresh `BOOTSTRAP.md` and `USER_BOOTSTRAP.md` from templates directory
3. **Preserves**: per-user `USER.md` files (in `users/` subdirectory) and `admins` list
4. Called via `ax bootstrap [agentName]` CLI command with confirmation prompt

The bootstrap triggers bootstrap mode in the prompt builder: IdentityModule shows only BOOTSTRAP.md, guiding the agent through initial identity discovery.

## Channel Config Generation

When channels like `slack` are selected, onboarding generates `channel_config` in ax.yaml:

```yaml
channel_config:
  slack:
    dm_policy: open
    require_mention: true
    allowed_users: []
    max_attachment_bytes: 1048576
```

Generated config passes Zod validation via `loadConfig()`.

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

**Modifying profile defaults:**
1. Change `PROFILE_DEFAULTS[profile]` in `prompts.ts`
2. Update wizard test expectations in `tests/onboarding/wizard.test.ts`

## Gotchas

- **`.env` never goes in ax.yaml**: Secrets (API keys, tokens, passphrases) go in `.env` only. The wizard enforces this separation.
- **'cli' is stripped from channels on load**: `loadExistingConfig` removes 'cli' from the channels list since it's always implicit. Don't count on it being in the loaded answers.
- **OAuth vs API key detection**: `loadExistingConfig` checks for `CLAUDE_CODE_OAUTH_TOKEN` in `.env` to determine auth method. Both can't coexist.
- **`skipSkills: true` suppresses .clawhub-install-queue**: Even if `installSkills` is provided, the queue file isn't written when `skipSkills` is true.
- **Bootstrap preserves per-user state**: `resetAgent` intentionally keeps `users/` directory. Only shared identity files are wiped.
- **Profile throws on unknown**: `runOnboarding` throws `'Unknown profile'` if the profile string doesn't match a known entry. Always validate upstream.
- **Channel config is per-profile**: Different profiles may want different channel defaults (e.g., paranoid might restrict `dm_policy`).
