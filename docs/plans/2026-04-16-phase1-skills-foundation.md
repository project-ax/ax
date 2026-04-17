# Phase 1 — Skills Foundation: Frontmatter Schema + Reconciler (headless)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the pure-logic core for git-native skills: a validated YAML frontmatter schema, a SKILL.md parser, and a reconciler that turns a workspace snapshot + current approvals into the next desired system state. Zero I/O, zero wiring — every piece unit-testable.

**Architecture:** New module at `src/host/skills/` with four files: `frontmatter-schema.ts` (Zod), `parser.ts` (YAML frontmatter split + schema validate), `types.ts` (reconciler inputs/outputs), `reconciler.ts` (pure function from snapshot + current state → desired state + events). No filesystem, no IPC, no event-bus wiring — phase 2+ plugs these in.

**Tech Stack:** TypeScript, Zod v4, `yaml` package (already in deps), vitest.

**Reference design:** `docs/plans/2026-04-16-git-native-skills-design.md` — Frontmatter Schema, Reconciliation Flow sections.

---

## Task 1: Directory + schema skeleton

**Files:**
- Create: `src/host/skills/frontmatter-schema.ts`
- Create: `tests/host/skills/frontmatter-schema.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/frontmatter-schema.test.ts
import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema } from '../../../src/host/skills/frontmatter-schema.js';

describe('SkillFrontmatterSchema', () => {
  it('accepts minimal valid frontmatter', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'linear',
      description: 'When the user wants to query Linear.',
    });
    expect(parsed.name).toBe('linear');
    expect(parsed.credentials).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('requires name and description', () => {
    expect(() => SkillFrontmatterSchema.parse({ name: 'x' })).toThrow();
    expect(() => SkillFrontmatterSchema.parse({ description: 'y' })).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        extraField: true,
      }),
    ).toThrow();
  });

  it('accepts an api_key credential (authType defaults to api_key)', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      credentials: [{ envName: 'FOO_TOKEN' }],
    });
    expect(parsed.credentials[0].authType).toBe('api_key');
    expect(parsed.credentials[0].scope).toBe('user');
  });

  it('accepts an oauth credential with full block', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      credentials: [
        {
          envName: 'LINEAR_TOKEN',
          authType: 'oauth',
          scope: 'user',
          oauth: {
            provider: 'linear',
            clientId: 'pub_abc',
            authorizationUrl: 'https://linear.app/oauth/authorize',
            tokenUrl: 'https://api.linear.app/oauth/token',
            scopes: ['read'],
          },
        },
      ],
    });
    expect(parsed.credentials[0].oauth?.provider).toBe('linear');
  });

  it('rejects oauth authType without oauth block', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        credentials: [{ envName: 'X', authType: 'oauth' }],
      }),
    ).toThrow();
  });

  it('rejects envName that is not SCREAMING_SNAKE_CASE', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        credentials: [{ envName: 'lowercase' }],
      }),
    ).toThrow();
  });

  it('accepts mcpServers referencing a credential by envName', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      credentials: [{ envName: 'FOO_TOKEN' }],
      mcpServers: [
        { name: 'foo', url: 'https://mcp.foo.com/sse', credential: 'FOO_TOKEN' },
      ],
    });
    expect(parsed.mcpServers[0].credential).toBe('FOO_TOKEN');
  });

  it('accepts domains and source', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      domains: ['api.linear.app'],
      source: { url: 'https://github.com/a/b', version: 'v1.0' },
    });
    expect(parsed.domains).toEqual(['api.linear.app']);
    expect(parsed.source?.version).toBe('v1.0');
  });

  it('rejects mcpServer URL that is not https', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        mcpServers: [{ name: 'n', url: 'http://insecure.example' }],
      }),
    ).toThrow();
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/frontmatter-schema.test.ts`
Expected: FAIL — cannot resolve import.

**Step 3: Implement the schema**

```ts
// src/host/skills/frontmatter-schema.ts
import { z } from 'zod';

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

const OAuthBlockSchema = z
  .object({
    provider: z.string().min(1).max(100),
    clientId: z.string().min(1).max(500),
    authorizationUrl: z.string().url().startsWith('https://'),
    tokenUrl: z.string().url().startsWith('https://'),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();

const CredentialSchema = z
  .object({
    envName: z.string().regex(ENV_NAME),
    authType: z.enum(['api_key', 'oauth']).default('api_key'),
    scope: z.enum(['user', 'agent']).default('user'),
    oauth: OAuthBlockSchema.optional(),
  })
  .strict()
  .refine(
    (c) => c.authType !== 'oauth' || c.oauth !== undefined,
    { message: 'oauth authType requires an oauth block' },
  );

const McpServerSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url().startsWith('https://'),
    credential: z.string().regex(ENV_NAME).optional(),
  })
  .strict();

const SourceSchema = z
  .object({
    url: z.string().url(),
    version: z.string().min(1).max(200).optional(),
  })
  .strict();

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    source: SourceSchema.optional(),
    credentials: z.array(CredentialSchema).default([]),
    mcpServers: z.array(McpServerSchema).default([]),
    domains: z.array(z.string().min(1).max(253)).default([]),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type SkillCredential = z.infer<typeof CredentialSchema>;
export type SkillMcpServer = z.infer<typeof McpServerSchema>;
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/frontmatter-schema.test.ts`
Expected: PASS (all 10).

**Step 5: Commit**

```bash
git add src/host/skills/frontmatter-schema.ts tests/host/skills/frontmatter-schema.test.ts
git commit -m "feat(skills): add SKILL.md frontmatter Zod schema"
```

---

## Task 2: SKILL.md parser

**Files:**
- Create: `src/host/skills/parser.ts`
- Create: `tests/host/skills/parser.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '../../../src/host/skills/parser.js';

describe('parseSkillFile', () => {
  it('parses valid frontmatter and body', () => {
    const content = `---
name: linear
description: Query Linear.
domains:
  - api.linear.app
---

# Linear
Body goes here.`;
    const result = parseSkillFile(content);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.frontmatter.name).toBe('linear');
    expect(result.frontmatter.domains).toEqual(['api.linear.app']);
    expect(result.body).toContain('# Linear');
  });

  it('reports missing frontmatter', () => {
    const result = parseSkillFile('# Just a heading\nNo frontmatter.');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/frontmatter/i);
  });

  it('reports unterminated frontmatter', () => {
    const result = parseSkillFile('---\nname: x\n# no closing ---');
    expect(result.ok).toBe(false);
  });

  it('reports invalid YAML', () => {
    const result = parseSkillFile('---\n: : : not valid\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/yaml/i);
  });

  it('reports schema validation errors', () => {
    const result = parseSkillFile('---\nname: x\n---\nno description');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/description/i);
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\nname: x\r\ndescription: y\r\n---\r\nbody';
    const result = parseSkillFile(content);
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/parser.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the parser**

```ts
// src/host/skills/parser.ts
import { parse as parseYaml } from 'yaml';
import { SkillFrontmatterSchema, type SkillFrontmatter } from './frontmatter-schema.js';

export type ParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; error: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillFile(content: string): ParseResult {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: false, error: 'missing or unterminated YAML frontmatter' };
  }
  const [, yamlText, body] = match;

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid YAML: ${msg}` };
  }

  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, frontmatter: parsed.data, body };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/parser.test.ts`
Expected: PASS (6).

**Step 5: Commit**

```bash
git add src/host/skills/parser.ts tests/host/skills/parser.test.ts
git commit -m "feat(skills): add SKILL.md frontmatter parser"
```

---

## Task 3: Reconciler types

**Files:**
- Create: `src/host/skills/types.ts`

No test file yet — these are type declarations consumed by later tasks.

**Step 1: Write types**

```ts
// src/host/skills/types.ts
import type { SkillFrontmatter } from './frontmatter-schema.js';

/** One parsed SKILL.md or a parse failure. Input to the reconciler. */
export type SkillSnapshotEntry =
  | { name: string; ok: true; frontmatter: SkillFrontmatter; body: string }
  | { name: string; ok: false; error: string };

/** Approvals + storage state the host already holds. */
export interface ReconcilerCurrentState {
  /** Domains the user has approved on the setup card, by exact host match. */
  approvedDomains: ReadonlySet<string>;
  /** Credentials currently stored, keyed by `${envName}@${scope}` ('user' or 'agent'). */
  storedCredentials: ReadonlySet<string>;
  /** MCP servers currently registered, keyed by name. */
  registeredMcpServers: ReadonlyMap<string, { url: string }>;
  /** Prior reconcile's enable state per skill — drives event diffs. */
  priorSkillStates: ReadonlyMap<string, SkillStateKind>;
}

export type SkillStateKind = 'enabled' | 'pending' | 'invalid';

export interface SkillState {
  name: string;
  kind: SkillStateKind;
  /** Human-readable reasons. Present for pending and invalid. */
  pendingReasons?: string[];
  /** Full error string for invalid. */
  error?: string;
  /** Short description surfaced in the prompt index. Present for valid frontmatter. */
  description?: string;
}

/** An entry queued onto a skill's setup card in the dashboard. */
export interface SetupRequest {
  skillName: string;
  description: string;
  missingCredentials: Array<{
    envName: string;
    authType: 'api_key' | 'oauth';
    scope: 'user' | 'agent';
    oauth?: {
      provider: string;
      clientId: string;
      authorizationUrl: string;
      tokenUrl: string;
      scopes: string[];
    };
  }>;
  unapprovedDomains: string[];
  /** Informational — user sees the URLs they are effectively authorizing. */
  mcpServers: Array<{ name: string; url: string }>;
}

/** The reconciler's verdict. Effects live with the caller (phase 2+). */
export interface ReconcilerOutput {
  skills: SkillState[];
  desired: {
    /** MCP servers to register after this cycle, keyed by name. */
    mcpServers: Map<string, { url: string; bearerCredential?: string }>;
    /** Union of domains from enabled skills, intersected with approved domains. */
    proxyAllowlist: Set<string>;
  };
  /** Setup cards to surface/update in the dashboard. */
  setupQueue: SetupRequest[];
  /** Events to emit on the event bus. Dot-namespaced types. */
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface ReconcilerInput {
  snapshot: SkillSnapshotEntry[];
  current: ReconcilerCurrentState;
}
```

**Step 2: Commit**

```bash
git add src/host/skills/types.ts
git commit -m "feat(skills): add reconciler types"
```

---

## Task 4: `computeSkillStates` — per-skill enabled / pending / invalid

**Files:**
- Create: `src/host/skills/reconciler.ts` (partial — this task adds one export)
- Create: `tests/host/skills/reconciler-states.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/reconciler-states.test.ts
import { describe, it, expect } from 'vitest';
import { computeSkillStates } from '../../../src/host/skills/reconciler.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';

function skill(overrides: Partial<SkillSnapshotEntry> = {}): SkillSnapshotEntry {
  return {
    name: 'linear',
    ok: true,
    frontmatter: {
      name: 'linear',
      description: 'Query Linear.',
      credentials: [],
      mcpServers: [],
      domains: [],
    },
    body: '',
    ...overrides,
  } as SkillSnapshotEntry;
}

describe('computeSkillStates', () => {
  it('marks a skill with no requirements as enabled', () => {
    const states = computeSkillStates([skill()], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('enabled');
    expect(states[0].description).toBe('Query Linear.');
  });

  it('marks skill pending when a credential is missing', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('pending');
    expect(states[0].pendingReasons?.some((r) => r.includes('LINEAR_TOKEN'))).toBe(true);
  });

  it('marks skill enabled when credential is stored at the declared scope', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(['LINEAR_TOKEN@user']),
    });
    expect(states[0].kind).toBe('enabled');
  });

  it('does not accept an agent-scoped credential as satisfying a user-scoped requirement', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(['LINEAR_TOKEN@agent']),
    });
    expect(states[0].kind).toBe('pending');
  });

  it('marks skill pending when a domain is unapproved', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [],
        mcpServers: [],
        domains: ['api.linear.app'],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('pending');
    expect(states[0].pendingReasons?.some((r) => r.includes('api.linear.app'))).toBe(true);
  });

  it('bubbles parse errors up as invalid', () => {
    const bad: SkillSnapshotEntry = { name: 'broken', ok: false, error: 'invalid YAML: x' };
    const states = computeSkillStates([bad], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('invalid');
    expect(states[0].error).toBe('invalid YAML: x');
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/reconciler-states.test.ts`
Expected: FAIL.

**Step 3: Implement `computeSkillStates`**

```ts
// src/host/skills/reconciler.ts
import type {
  SkillSnapshotEntry,
  SkillState,
  ReconcilerCurrentState,
} from './types.js';

/**
 * Per-skill enabled/pending/invalid. Exposed as a named export for
 * focused testing; the top-level `reconcile` composes this with the
 * rest of the pipeline.
 */
export function computeSkillStates(
  snapshot: SkillSnapshotEntry[],
  current: Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'>,
): SkillState[] {
  return snapshot.map((entry) => {
    if (!entry.ok) {
      return { name: entry.name, kind: 'invalid', error: entry.error };
    }
    const fm = entry.frontmatter;
    const reasons: string[] = [];

    for (const cred of fm.credentials) {
      const key = `${cred.envName}@${cred.scope}`;
      if (!current.storedCredentials.has(key)) {
        reasons.push(`missing credential ${cred.envName} (${cred.scope})`);
      }
    }
    for (const domain of fm.domains) {
      if (!current.approvedDomains.has(domain)) {
        reasons.push(`domain not approved: ${domain}`);
      }
    }
    if (reasons.length === 0) {
      return { name: entry.name, kind: 'enabled', description: fm.description };
    }
    return {
      name: entry.name,
      kind: 'pending',
      pendingReasons: reasons,
      description: fm.description,
    };
  });
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/reconciler-states.test.ts`
Expected: PASS (6).

**Step 5: Commit**

```bash
git add src/host/skills/reconciler.ts tests/host/skills/reconciler-states.test.ts
git commit -m "feat(skills): compute per-skill enabled/pending/invalid state"
```

---

## Task 5: MCP desired state (reference-counted, conflict detection)

**Files:**
- Modify: `src/host/skills/reconciler.ts` (add `computeMcpDesired`)
- Create: `tests/host/skills/reconciler-mcp.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/reconciler-mcp.test.ts
import { describe, it, expect } from 'vitest';
import { computeMcpDesired } from '../../../src/host/skills/reconciler.js';
import type { SkillSnapshotEntry, SkillState } from '../../../src/host/skills/types.js';

const enabled = (name: string): SkillState => ({ name, kind: 'enabled', description: 'd' });

function skill(
  name: string,
  mcpServers: Array<{ name: string; url: string; credential?: string }> = [],
): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    frontmatter: {
      name,
      description: 'd',
      credentials: [],
      mcpServers,
      domains: [],
    },
    body: '',
  } as SkillSnapshotEntry;
}

describe('computeMcpDesired', () => {
  it('registers MCP servers for enabled skills only', () => {
    const snapshot = [
      skill('a', [{ name: 'foo', url: 'https://mcp.foo.com' }]),
      skill('b', [{ name: 'bar', url: 'https://mcp.bar.com' }]),
    ];
    const states: SkillState[] = [enabled('a'), { name: 'b', kind: 'pending' }];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, states);
    expect(mcpServers.get('foo')?.url).toBe('https://mcp.foo.com');
    expect(mcpServers.has('bar')).toBe(false);
    expect(conflicts).toEqual([]);
  });

  it('reference-counts across skills — same name + same URL OK', () => {
    const snapshot = [
      skill('a', [{ name: 'shared', url: 'https://m.example' }]),
      skill('b', [{ name: 'shared', url: 'https://m.example' }]),
    ];
    const states: SkillState[] = [enabled('a'), enabled('b')];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, states);
    expect(mcpServers.size).toBe(1);
    expect(conflicts).toEqual([]);
  });

  it('flags a conflict when the same MCP name has different URLs', () => {
    const snapshot = [
      skill('a', [{ name: 'shared', url: 'https://one.example' }]),
      skill('b', [{ name: 'shared', url: 'https://two.example' }]),
    ];
    const states: SkillState[] = [enabled('a'), enabled('b')];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, states);
    // First occurrence wins; second skill is flagged.
    expect(mcpServers.get('shared')?.url).toBe('https://one.example');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ skillName: 'b', mcpName: 'shared' });
  });

  it('passes through bearerCredential when declared', () => {
    const snapshot = [
      skill('a', [{ name: 'foo', url: 'https://m.example', credential: 'FOO_TOKEN' }]),
    ];
    const { mcpServers } = computeMcpDesired(snapshot, [enabled('a')]);
    expect(mcpServers.get('foo')?.bearerCredential).toBe('FOO_TOKEN');
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/reconciler-mcp.test.ts`
Expected: FAIL.

**Step 3: Implement `computeMcpDesired`**

Append to `src/host/skills/reconciler.ts`:

```ts
export interface McpConflict {
  skillName: string;
  mcpName: string;
  declaredUrl: string;
  conflictingUrl: string;
}

export function computeMcpDesired(
  snapshot: SkillSnapshotEntry[],
  states: SkillState[],
): {
  mcpServers: Map<string, { url: string; bearerCredential?: string }>;
  conflicts: McpConflict[];
} {
  const enabledNames = new Set(states.filter((s) => s.kind === 'enabled').map((s) => s.name));
  const servers = new Map<string, { url: string; bearerCredential?: string }>();
  const conflicts: McpConflict[] = [];

  for (const entry of snapshot) {
    if (!entry.ok || !enabledNames.has(entry.name)) continue;
    for (const mcp of entry.frontmatter.mcpServers) {
      const existing = servers.get(mcp.name);
      if (existing) {
        if (existing.url !== mcp.url) {
          conflicts.push({
            skillName: entry.name,
            mcpName: mcp.name,
            declaredUrl: mcp.url,
            conflictingUrl: existing.url,
          });
        }
        continue;
      }
      servers.set(mcp.name, {
        url: mcp.url,
        bearerCredential: mcp.credential,
      });
    }
  }
  return { mcpServers: servers, conflicts };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/reconciler-mcp.test.ts`
Expected: PASS (4).

**Step 5: Commit**

```bash
git add src/host/skills/reconciler.ts tests/host/skills/reconciler-mcp.test.ts
git commit -m "feat(skills): compute MCP desired state with conflict detection"
```

---

## Task 6: Proxy allowlist desired state

**Files:**
- Modify: `src/host/skills/reconciler.ts` (add `computeProxyAllowlist`)
- Create: `tests/host/skills/reconciler-allowlist.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/reconciler-allowlist.test.ts
import { describe, it, expect } from 'vitest';
import { computeProxyAllowlist } from '../../../src/host/skills/reconciler.js';
import type { SkillSnapshotEntry, SkillState } from '../../../src/host/skills/types.js';

const enabled = (name: string): SkillState => ({ name, kind: 'enabled', description: 'd' });
const pending = (name: string): SkillState => ({ name, kind: 'pending', description: 'd' });

function skill(name: string, domains: string[] = []): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    frontmatter: {
      name,
      description: 'd',
      credentials: [],
      mcpServers: [],
      domains,
    },
    body: '',
  } as SkillSnapshotEntry;
}

describe('computeProxyAllowlist', () => {
  it('is the union of domains of enabled skills (no filtering needed — approval already gated enable)', () => {
    const snapshot = [skill('a', ['api.foo']), skill('b', ['api.bar'])];
    const allowed = computeProxyAllowlist(snapshot, [enabled('a'), enabled('b')]);
    expect([...allowed].sort()).toEqual(['api.bar', 'api.foo']);
  });

  it('excludes domains of pending skills', () => {
    const snapshot = [skill('a', ['api.foo']), skill('b', ['api.bar'])];
    const allowed = computeProxyAllowlist(snapshot, [enabled('a'), pending('b')]);
    expect([...allowed]).toEqual(['api.foo']);
  });

  it('dedupes domains shared between enabled skills', () => {
    const snapshot = [skill('a', ['shared.com']), skill('b', ['shared.com'])];
    const allowed = computeProxyAllowlist(snapshot, [enabled('a'), enabled('b')]);
    expect([...allowed]).toEqual(['shared.com']);
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/reconciler-allowlist.test.ts`
Expected: FAIL.

**Step 3: Implement `computeProxyAllowlist`**

Append to `src/host/skills/reconciler.ts`:

```ts
export function computeProxyAllowlist(
  snapshot: SkillSnapshotEntry[],
  states: SkillState[],
): Set<string> {
  const enabledNames = new Set(states.filter((s) => s.kind === 'enabled').map((s) => s.name));
  const out = new Set<string>();
  for (const entry of snapshot) {
    if (!entry.ok || !enabledNames.has(entry.name)) continue;
    for (const d of entry.frontmatter.domains) out.add(d);
  }
  return out;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/reconciler-allowlist.test.ts`
Expected: PASS (3).

**Step 5: Commit**

```bash
git add src/host/skills/reconciler.ts tests/host/skills/reconciler-allowlist.test.ts
git commit -m "feat(skills): compute proxy allowlist from enabled skills"
```

---

## Task 7: Setup queue

**Files:**
- Modify: `src/host/skills/reconciler.ts` (add `computeSetupQueue`)
- Create: `tests/host/skills/reconciler-setup.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/reconciler-setup.test.ts
import { describe, it, expect } from 'vitest';
import { computeSetupQueue } from '../../../src/host/skills/reconciler.js';
import type { SkillSnapshotEntry, ReconcilerCurrentState } from '../../../src/host/skills/types.js';

const empty: Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'> = {
  approvedDomains: new Set(),
  storedCredentials: new Set(),
};

describe('computeSetupQueue', () => {
  it('emits a setup request for a pending skill with missing credential + unapproved domain', () => {
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'Query Linear.',
          credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
          mcpServers: [{ name: 'linear', url: 'https://mcp.linear.app/sse' }],
          domains: ['api.linear.app'],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, empty);
    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');
    expect(queue[0].missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(queue[0].unapprovedDomains).toEqual(['api.linear.app']);
    expect(queue[0].mcpServers[0].url).toBe('https://mcp.linear.app/sse');
  });

  it('emits nothing for a skill whose requirements are all satisfied', () => {
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'x',
          credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
          mcpServers: [],
          domains: ['api.linear.app'],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, {
      approvedDomains: new Set(['api.linear.app']),
      storedCredentials: new Set(['LINEAR_TOKEN@user']),
    });
    expect(queue).toEqual([]);
  });

  it('carries OAuth block metadata through to the setup request', () => {
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'x',
          credentials: [
            {
              envName: 'LINEAR_TOKEN',
              authType: 'oauth',
              scope: 'user',
              oauth: {
                provider: 'linear',
                clientId: 'pub_abc',
                authorizationUrl: 'https://linear.app/oauth/authorize',
                tokenUrl: 'https://api.linear.app/oauth/token',
                scopes: ['read'],
              },
            },
          ],
          mcpServers: [],
          domains: [],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, empty);
    expect(queue[0].missingCredentials[0].oauth?.provider).toBe('linear');
  });

  it('skips invalid snapshot entries', () => {
    const snapshot: SkillSnapshotEntry[] = [{ name: 'broken', ok: false, error: 'bad' }];
    const queue = computeSetupQueue(snapshot, empty);
    expect(queue).toEqual([]);
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/reconciler-setup.test.ts`
Expected: FAIL.

**Step 3: Implement `computeSetupQueue`**

Append to `src/host/skills/reconciler.ts`:

```ts
import type { SetupRequest } from './types.js';

export function computeSetupQueue(
  snapshot: SkillSnapshotEntry[],
  current: Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'>,
): SetupRequest[] {
  const out: SetupRequest[] = [];
  for (const entry of snapshot) {
    if (!entry.ok) continue;
    const fm = entry.frontmatter;
    const missingCredentials = fm.credentials
      .filter((c) => !current.storedCredentials.has(`${c.envName}@${c.scope}`))
      .map((c) => ({
        envName: c.envName,
        authType: c.authType,
        scope: c.scope,
        oauth: c.oauth,
      }));
    const unapprovedDomains = fm.domains.filter((d) => !current.approvedDomains.has(d));
    if (missingCredentials.length === 0 && unapprovedDomains.length === 0) continue;
    out.push({
      skillName: entry.name,
      description: fm.description,
      missingCredentials,
      unapprovedDomains,
      mcpServers: fm.mcpServers.map((m) => ({ name: m.name, url: m.url })),
    });
  }
  return out;
}
```

Also add the type import at the top of the file (if not already covered by path).

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/reconciler-setup.test.ts`
Expected: PASS (4).

**Step 5: Commit**

```bash
git add src/host/skills/reconciler.ts tests/host/skills/reconciler-setup.test.ts
git commit -m "feat(skills): compute setup queue for pending skills"
```

---

## Task 8: Event diff against prior state

**Files:**
- Modify: `src/host/skills/reconciler.ts` (add `computeEvents`)
- Create: `tests/host/skills/reconciler-events.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/host/skills/reconciler-events.test.ts
import { describe, it, expect } from 'vitest';
import { computeEvents } from '../../../src/host/skills/reconciler.js';
import type { SkillState } from '../../../src/host/skills/types.js';

const e = (name: string): SkillState => ({ name, kind: 'enabled', description: 'd' });
const p = (name: string, reasons: string[] = ['x']): SkillState => ({
  name,
  kind: 'pending',
  description: 'd',
  pendingReasons: reasons,
});
const inv = (name: string): SkillState => ({ name, kind: 'invalid', error: 'bad' });

describe('computeEvents', () => {
  it('emits skill.installed + skill.enabled for a new enabled skill', () => {
    const events = computeEvents([e('a')], new Map());
    const types = events.map((ev) => ev.type);
    expect(types).toContain('skill.installed');
    expect(types).toContain('skill.enabled');
  });

  it('emits skill.installed + skill.pending for a new pending skill', () => {
    const events = computeEvents([p('a')], new Map());
    const types = events.map((ev) => ev.type);
    expect(types).toContain('skill.installed');
    expect(types).toContain('skill.pending');
  });

  it('emits skill.invalid with the error', () => {
    const events = computeEvents([inv('a')], new Map());
    expect(events.find((ev) => ev.type === 'skill.invalid')?.data.error).toBe('bad');
  });

  it('emits skill.removed when a previously-known skill is gone', () => {
    const prior = new Map([['gone', 'enabled' as const]]);
    const events = computeEvents([], prior);
    expect(events.map((ev) => ev.type)).toContain('skill.removed');
  });

  it('emits skill.enabled when a pending skill transitions to enabled', () => {
    const prior = new Map([['a', 'pending' as const]]);
    const events = computeEvents([e('a')], prior);
    const types = events.map((ev) => ev.type);
    expect(types).toContain('skill.enabled');
    expect(types).not.toContain('skill.installed'); // not new
  });

  it('emits no events when state is unchanged', () => {
    const prior = new Map([['a', 'enabled' as const]]);
    expect(computeEvents([e('a')], prior)).toEqual([]);
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/reconciler-events.test.ts`
Expected: FAIL.

**Step 3: Implement `computeEvents`**

Append to `src/host/skills/reconciler.ts`:

```ts
import type { SkillStateKind } from './types.js';

export function computeEvents(
  states: SkillState[],
  priorStates: ReadonlyMap<string, SkillStateKind>,
): Array<{ type: string; data: Record<string, unknown> }> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();

  for (const s of states) {
    seen.add(s.name);
    const prior = priorStates.get(s.name);
    if (!prior) {
      events.push({ type: 'skill.installed', data: { name: s.name } });
    }
    if (prior !== s.kind) {
      const type =
        s.kind === 'enabled'
          ? 'skill.enabled'
          : s.kind === 'pending'
            ? 'skill.pending'
            : 'skill.invalid';
      events.push({
        type,
        data: {
          name: s.name,
          reasons: s.pendingReasons,
          error: s.error,
        },
      });
    }
  }
  for (const [name] of priorStates) {
    if (!seen.has(name)) {
      events.push({ type: 'skill.removed', data: { name } });
    }
  }
  return events;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skills/reconciler-events.test.ts`
Expected: PASS (6).

**Step 5: Commit**

```bash
git add src/host/skills/reconciler.ts tests/host/skills/reconciler-events.test.ts
git commit -m "feat(skills): compute skill lifecycle events from state diff"
```

---

## Task 9: `reconcile()` orchestration + integration test

**Files:**
- Modify: `src/host/skills/reconciler.ts` (add `reconcile`)
- Create: `tests/host/skills/reconcile.test.ts`

**Step 1: Write the failing integration test**

```ts
// tests/host/skills/reconcile.test.ts
import { describe, it, expect } from 'vitest';
import { reconcile } from '../../../src/host/skills/reconciler.js';
import type { ReconcilerInput } from '../../../src/host/skills/types.js';

describe('reconcile', () => {
  it('handles a realistic two-skill snapshot end to end', () => {
    const input: ReconcilerInput = {
      snapshot: [
        {
          name: 'linear',
          ok: true,
          body: '# Linear',
          frontmatter: {
            name: 'linear',
            description: 'Query Linear.',
            credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
            mcpServers: [
              { name: 'linear', url: 'https://mcp.linear.app/sse', credential: 'LINEAR_TOKEN' },
            ],
            domains: ['api.linear.app', 'mcp.linear.app'],
          },
        },
        {
          name: 'weather',
          ok: true,
          body: '# Weather',
          frontmatter: {
            name: 'weather',
            description: 'Get the forecast.',
            credentials: [],
            mcpServers: [],
            domains: ['api.weather.gov'],
          },
        },
      ],
      current: {
        approvedDomains: new Set(['api.weather.gov']),
        storedCredentials: new Set(),
        registeredMcpServers: new Map(),
        priorSkillStates: new Map(),
      },
    };

    const out = reconcile(input);

    // Per-skill state
    const byName = new Map(out.skills.map((s) => [s.name, s]));
    expect(byName.get('linear')?.kind).toBe('pending');
    expect(byName.get('weather')?.kind).toBe('enabled');

    // Desired — MCP only from enabled skills
    expect(out.desired.mcpServers.size).toBe(0);

    // Desired — proxy allowlist is only weather's domain
    expect([...out.desired.proxyAllowlist]).toEqual(['api.weather.gov']);

    // Setup queue — only the pending skill
    expect(out.setupQueue.map((s) => s.skillName)).toEqual(['linear']);
    expect(out.setupQueue[0].missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(out.setupQueue[0].unapprovedDomains.sort()).toEqual([
      'api.linear.app',
      'mcp.linear.app',
    ]);

    // Events — two installed, one enabled, one pending
    const types = out.events.map((e) => e.type).sort();
    expect(types).toEqual(['skill.enabled', 'skill.installed', 'skill.installed', 'skill.pending']);
  });

  it('surfaces an invalid snapshot entry as skill.invalid without blocking other skills', () => {
    const input: ReconcilerInput = {
      snapshot: [
        { name: 'broken', ok: false, error: 'invalid YAML: foo' },
        {
          name: 'ok',
          ok: true,
          body: '',
          frontmatter: {
            name: 'ok',
            description: 'ok',
            credentials: [],
            mcpServers: [],
            domains: [],
          },
        },
      ],
      current: {
        approvedDomains: new Set(),
        storedCredentials: new Set(),
        registeredMcpServers: new Map(),
        priorSkillStates: new Map(),
      },
    };
    const out = reconcile(input);
    expect(out.skills.find((s) => s.name === 'broken')?.kind).toBe('invalid');
    expect(out.skills.find((s) => s.name === 'ok')?.kind).toBe('enabled');
  });
});
```

**Step 2: Run to confirm failure**

Run: `npx vitest run tests/host/skills/reconcile.test.ts`
Expected: FAIL — `reconcile` not exported.

**Step 3: Implement `reconcile`**

Append to `src/host/skills/reconciler.ts`:

```ts
import type { ReconcilerInput, ReconcilerOutput } from './types.js';

export function reconcile(input: ReconcilerInput): ReconcilerOutput {
  const { snapshot, current } = input;

  const skills = computeSkillStates(snapshot, current);
  const { mcpServers, conflicts } = computeMcpDesired(snapshot, skills);
  const proxyAllowlist = computeProxyAllowlist(snapshot, skills);
  const setupQueue = computeSetupQueue(snapshot, current);
  const events = computeEvents(skills, current.priorSkillStates);

  for (const c of conflicts) {
    events.push({
      type: 'skill.mcp_conflict',
      data: c as unknown as Record<string, unknown>,
    });
  }
  return {
    skills,
    desired: { mcpServers, proxyAllowlist },
    setupQueue,
    events,
  };
}
```

**Step 4: Run the whole skills test suite**

Run: `npx vitest run tests/host/skills/`
Expected: ALL PASS.

**Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: ALL PASS (or: pre-existing failures unrelated to skills/ remain unchanged).

**Step 6: Commit**

```bash
git add src/host/skills/reconciler.ts tests/host/skills/reconcile.test.ts
git commit -m "feat(skills): add reconcile() orchestration + integration tests"
```

---

## Phase-1 wrap-up

**What exists now:**
- `src/host/skills/frontmatter-schema.ts` — Zod strict schema.
- `src/host/skills/parser.ts` — `parseSkillFile(content) → {ok, frontmatter, body} | {ok: false, error}`.
- `src/host/skills/types.ts` — reconciler I/O types.
- `src/host/skills/reconciler.ts` — `reconcile(input) → output` plus focused named exports.

**What does not yet exist** (phase 2+):
- Filesystem snapshot (walking `.ax/skills/` from a git ref).
- Event-bus wiring (events are returned, not emitted).
- Effect application (nobody calls `McpConnectionManager.register` or `ProxyDomainList.set` yet).
- Post-receive hook to trigger reconcile.
- Prior-state persistence between reconciles (caller supplies `priorSkillStates`).

**Journal & lessons before closing the branch:**
- Append an entry to `.claude/journal/providers/skills.md` (create the file + index entry if needed) summarizing the phase.
- If anything surprising came up (e.g. a Zod v4 gotcha, a YAML edge case), record an actionable lesson under `.claude/lessons/`.

**Next plan:** `docs/plans/2026-04-16-phase2-skills-git-hooks.md` — post-receive wiring for `git-local` and `git-http` that produces a `SkillSnapshotEntry[]` and calls `reconcile`, with effects still stubbed.
