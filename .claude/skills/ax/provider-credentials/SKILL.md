---
name: ax-provider-credentials
description: Use when modifying credential storage providers — env vars, AES-256-GCM encrypted file, or OS keychain in src/providers/credentials/
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
| env | `src/providers/credentials/env.ts` | `process.env` lookup (read-only) | Low -- plaintext in memory |
| encrypted | `src/providers/credentials/encrypted.ts` | AES-256-GCM encrypted JSON file at `data/credentials.enc` | Medium -- passphrase-derived key |
| keychain | `src/providers/credentials/keychain.ts` | OS native keychain via `keytar` (macOS Keychain, GNOME Keyring, Windows Credential Locker) | High -- OS-managed |

All providers export `create(config: Config): Promise<CredentialProvider>`. Registered in `src/host/provider-map.ts` static allowlist (SC-SEC-002).

## Encrypted Provider

- Uses AES-256-GCM with PBKDF2 key derivation (100k iterations, SHA-512)
- Passphrase set via `AX_CREDS_PASSPHRASE` env var; store path via `AX_CREDS_STORE_PATH` or default `data/credentials.enc`
- If no passphrase is set, logs a warning and falls back to env provider
- Wrong passphrase returns an empty store (catch block returns `{}`), does **not** throw
- Store is cached in memory after first load; re-encrypted on every write

## Common Tasks

**Adding a new credential provider:**
1. Create `src/providers/credentials/<name>.ts` exporting `create(config: Config): Promise<CredentialProvider>`
2. Implement all 4 methods: `get`, `set`, `delete`, `list`
3. Register in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
4. Add tests at `tests/providers/credentials/<name>.test.ts`
5. Use `safePath()` for any file path construction from input

## Gotchas

- **Wrong passphrase must fail gracefully:** The encrypted provider catches decryption errors and returns an empty store (`{}`), not an exception. Tests verify `get()` returns `null`, not that it throws.
- **Credentials never enter agent containers:** The host holds credentials and injects them into outbound API requests via the credential-injecting proxy. Agents receive a dummy key and `ANTHROPIC_BASE_URL` pointing to the proxy.
- **Env provider is read-only:** `set()` and `delete()` throw errors. Use encrypted or keychain for writes.
- **Keychain fallback chain:** If `keytar` is not installed, keychain provider falls back to encrypted provider. If passphrase is not set, encrypted falls back to env.
