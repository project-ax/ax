---
name: ax-provider-web
description: Use when modifying web access providers -- proxied HTTP fetch, DNS pinning, taint tagging, or web search in src/providers/web/
---

## Overview

Web providers handle HTTP fetch and web search for agents, with DNS pinning to prevent SSRF and automatic taint tagging on all responses. Agents have no direct network access -- all web requests route through the host via IPC.

## Interface (`src/providers/web/types.ts`)

| Type            | Key Fields                                            |
|-----------------|-------------------------------------------------------|
| `FetchRequest`  | `url`, `method?` (GET/HEAD), `headers?`, `timeoutMs?` |
| `FetchResponse` | `status`, `headers`, `body`, `taint: TaintTag`        |
| `SearchResult`  | `title`, `url`, `snippet`, `taint: TaintTag`          |
| `WebProvider`   | `fetch(req)`, `search(query, maxResults?)`             |

Every response carries a `TaintTag` with `trust: 'external'`.

## Implementations

| Name     | File                           | Purpose                                     |
|----------|--------------------------------|---------------------------------------------|
| `fetch`  | `src/providers/web/fetch.ts`   | Direct HTTP fetch with DNS pinning           |
| `tavily` | `src/providers/web/tavily.ts`  | Tavily SDK for web search and page extraction |
| `none`   | `src/providers/web/none.ts`    | Disabled stub (returns `disabledProvider()`)  |

All three are registered in `src/host/provider-map.ts` under the `web` kind.

## Fetch Provider (`fetch.ts`)

- **DNS pinning:** Resolves hostname once via `dns/promises.lookup`, checks the IP against private ranges (IPv4 + IPv6), then connects to the pinned IP directly. Prevents TOCTOU DNS rebinding.
- **Private IP blocking:** Rejects `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `0.0.0.0/8`, `::1`, `fe80:`, `fc/fd`.
- **Body size limit:** 1 MB max, streaming reader with truncation.
- **Timeout:** Default 10s, configurable via `timeoutMs`.
- **Protocol:** Only `http:` and `https:` allowed.
- **Search:** Not implemented -- throws with message to use `tavily`.
- **Testing:** `allowedIPs` option bypasses private-range blocking for tests.

## Tavily Provider (`tavily.ts`)

- Uses `@tavily/core` SDK. Requires `TAVILY_API_KEY` env var.
- **fetch():** Uses Tavily Extract API (returns markdown content).
- **search():** Uses Tavily Search API. Default 5 results, max 20.
- Both methods taint-tag results as `external`.

## Common Tasks

### Adding a new web provider

1. Create `src/providers/web/<name>.ts` implementing `WebProvider`.
2. Export `create(config: Config): Promise<WebProvider>`.
3. Add `<name>: '../providers/web/<name>.js'` to the `web` section in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/web/<name>.test.ts`.

## Gotchas

- **All web responses are auto-tainted** with `trust: 'external'`. Never strip or skip the taint tag.
- **DNS pinning prevents SSRF.** The fetch provider resolves DNS once and connects to the pinned IP. Do not bypass this.
- **Agents have no direct network.** All web access routes through host-side IPC. The provider runs in the host process.
- **Tavily needs an API key** at runtime (`TAVILY_API_KEY`). The fetch provider needs no credentials.
- **`create()` is async** in all web providers (returns `Promise<WebProvider>`).
