---
name: ax-provider-credentials
description: Use when modifying credential storage providers — plaintext env vars or OS keychain in src/providers/credentials/
---

## Overview

Credential providers store and retrieve secrets (API keys, tokens) for the host process. Credentials never enter agent containers -- the host injects them via the credential-injecting proxy at request time.

## Interface

Defined in `src/providers/credentials/types.ts`:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `get` | `(service: string) => Promise<string \| null>` | Retrieve a credential by service name |
| `set` | `(service: string, value: string) => Promise<void>` | Store a credential |
| `delete` | `(service: string) => Promise<void>` | Remove a credential |
| `list` | `() => Promise<string[]>` | List all stored service names |

## Implementations

| Name | File | Storage Mechanism | Security Level |
|------|------|-------------------|----------------|
| plaintext | `src/providers/credentials/plaintext.ts` | `process.env` lookup (read-only) | Low -- plaintext in memory |
| keychain | `src/providers/credentials/keychain.ts` | OS native keychain via `keytar` (macOS Keychain, GNOME Keyring, Windows Credential Locker) | High -- OS-managed |

All providers export `create(config: Config): Promise<CredentialProvider>`. Registered in `src/host/provider-map.ts` static allowlist (SC-SEC-002).

## Common Tasks

**Adding a new credential provider:**
1. Create `src/providers/credentials/<name>.ts` exporting `create(config: Config): Promise<CredentialProvider>`
2. Implement all 4 methods: `get`, `set`, `delete`, `list`
3. Register in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
4. Add tests at `tests/providers/credentials/<name>.test.ts`
5. Use `safePath()` for any file path construction from input

## Gotchas

- **Credentials never enter agent containers:** The host holds credentials and injects them into outbound API requests via the credential-injecting proxy. Agents receive a dummy key and `ANTHROPIC_BASE_URL` pointing to the proxy.
- **Plaintext provider is read-only:** `set()` and `delete()` throw errors. Use keychain for writes.
