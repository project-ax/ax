---
name: provider-browser
description: Use when modifying browser automation providers — sandboxed Playwright, page snapshots, or element interaction in src/providers/browser/
---

## Overview

Browser providers handle sandboxed web automation, exposing structured commands (navigate, snapshot, click, type, screenshot) instead of raw JS execution. All page content is external and must be taint-tagged at the IPC boundary.

## Interface

```typescript
// src/providers/browser/types.ts
interface BrowserConfig {
  headless?: boolean;
  viewport?: { width?: number; height?: number };
}

interface BrowserSession { id: string; }

interface PageSnapshot {
  title: string;
  url: string;
  text: string;                                    // innerText, capped at 50k chars
  refs: { ref: number; tag: string; text: string }[];  // interactive elements, max 200
}

interface BrowserProvider {
  launch(config: BrowserConfig): Promise<BrowserSession>;
  navigate(session: string, url: string): Promise<void>;
  snapshot(session: string): Promise<PageSnapshot>;
  click(session: string, ref: number): Promise<void>;
  type(session: string, ref: number, text: string): Promise<void>;
  screenshot(session: string): Promise<Buffer>;
  close(session: string): Promise<void>;
}
```

## Implementations

| Name | File | Status |
|------|------|--------|
| container | `src/providers/browser/container.ts` | Active -- sandboxed Playwright (Chromium); domain allowlist via `AX_BROWSER_ALLOWED_DOMAINS` env var; optional dep dynamically imported |
| none | `src/providers/browser/none.ts` | Stub -- returns `disabledProvider()` proxy; used when Playwright is not installed |

## Common Tasks: Adding a New Browser Provider

1. Create `src/providers/browser/<name>.ts` exporting `create(config: Config): Promise<BrowserProvider>`.
2. Implement all 7 methods from `BrowserProvider`. Use `randomUUID()` for session IDs.
3. Cap `text` at `MAX_TEXT_CHARS` and `refs` at `MAX_REFS` in `snapshot()` to bound payload size.
4. Add the entry to the static allowlist in `src/host/provider-map.ts`.
5. Add tests in `tests/providers/browser/<name>.test.ts`.
6. Use `safePath()` if the provider reads any files from config-derived paths.

## Gotchas

- **Browser actions route through IPC.** The agent never has direct browser access -- all calls go host-side via IPC actions. Page content returned to the agent must be taint-tagged as external.
- **Domain allowlist is enforced in `navigate()`.** Set `AX_BROWSER_ALLOWED_DOMAINS` (comma-separated) to restrict navigation. When unset, all domains are allowed.
- **Playwright is optional.** `container.ts` dynamically imports `playwright` and falls back to the `none` provider on import failure. Never add a top-level Playwright import.
- **No raw JS exposed to agent.** `page.evaluate()` is used internally for snapshot extraction only -- the agent interface is structured commands (`click(ref)`, `type(ref, text)`), not arbitrary script execution.
- **Ref indices are positional.** `refs[i]` corresponds to the i-th element matching `INTERACTIVE_SELECTOR` at snapshot time. Refs are invalidated by any page mutation (navigation, click, type).
