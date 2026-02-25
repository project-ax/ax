---
name: ax-provider-system
description: Use when adding new provider categories, modifying provider loading, or understanding the provider contract pattern -- registry.ts, provider-map.ts, and the create(config) convention
---

## Overview

AX uses a **provider contract pattern**: every subsystem is a TypeScript interface with pluggable implementations. Implementations are selected by name in `ax.yaml`, resolved via a static allowlist (`provider-map.ts`), and instantiated by `registry.ts` calling each module's `create(config)` export. This enforces SC-SEC-002 -- no dynamic path construction.

## The Contract

1. Each **category** lives in `src/providers/<category>/` with a co-located `types.ts` defining the interface.
2. Each **implementation** exports `create(config: Config)` returning the provider instance.
3. `provider-map.ts` maps `(kind, name)` pairs to static import paths.
4. `registry.ts` resolves the path, imports the module, and calls `mod.create(config)`.

## Provider Categories

| Category      | Interface             | Directory                      |
|---------------|-----------------------|--------------------------------|
| llm           | `LLMProvider`         | `src/providers/llm/`           |
| memory        | `MemoryProvider`      | `src/providers/memory/`        |
| scanner       | `ScannerProvider`     | `src/providers/scanner/`       |
| channel       | `ChannelProvider`     | `src/providers/channel/`       |
| web           | `WebProvider`         | `src/providers/web/`           |
| browser       | `BrowserProvider`     | `src/providers/browser/`       |
| credentials   | `CredentialProvider`  | `src/providers/credentials/`   |
| skills        | `SkillStoreProvider`  | `src/providers/skills/`        |
| audit         | `AuditProvider`       | `src/providers/audit/`         |
| sandbox       | `SandboxProvider`     | `src/providers/sandbox/`       |
| scheduler     | `SchedulerProvider`   | `src/providers/scheduler/`     |

`skillScreener` (`SkillScreenerProvider`) is defined but not yet wired into the registry.

## Provider Map (SC-SEC-002)

`src/host/provider-map.ts` exports `PROVIDER_MAP` -- a frozen record mapping every valid `(kind, name)` to a relative import path. `resolveProviderPath()` looks up the pair and throws if missing. **No dynamic path construction is permitted.** Every new provider must be a static entry here.

## Registry

`src/host/registry.ts` exports `loadProviders(config)` returning a `ProviderRegistry`:

- Reads provider names from `config.providers.*`
- Calls `loadProvider(kind, name, config)` for each
- `loadProvider`: `resolveProviderPath` -> `await import()` -> validates `mod.create` is a function -> `mod.create(config)`
- Channels load as an array (`config.providers.channels` is `string[]`)

## Common Tasks

### Adding an implementation to an existing category

1. Create `src/providers/<category>/<name>.ts` implementing the category interface.
2. Export `create(config: Config)` returning the provider instance.
3. Add the `(kind, name)` entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add a test in `tests/providers/<category>/<name>.test.ts`.

### Adding an entirely new provider category

1. Create `src/providers/<category>/types.ts` with the provider interface.
2. Create at least one implementation file exporting `create(config)`.
3. Add the category to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add the provider name field to `Config.providers` in `src/types.ts`.
5. Add the typed field to `ProviderRegistry` in `src/types.ts` (import the interface).
6. Add the `loadProvider()` call in `registry.ts`'s `loadProviders()`.
7. Add tests in `tests/providers/<category>/`.

## Gotchas

- **Static allowlist is mandatory.** Skipping `provider-map.ts` means a runtime throw.
- **`ProviderRegistry` must match.** Forgetting the field in `src/types.ts` causes compile errors downstream.
- **Co-located `types.ts`.** Each category owns its interface. Shared types live in `src/types.ts`.
- **`channels` is an array.** `config.providers.channels` is `string[]`, returning `ChannelProvider[]`.
- **`create()` validated at runtime.** `loadProvider()` throws if the export is missing.
- **Use `safePath()`** for any file-based provider constructing paths from input.
