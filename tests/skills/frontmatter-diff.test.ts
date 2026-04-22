// tests/skills/frontmatter-diff.test.ts
//
// Unit tests for the frontmatter-diff helper that gates non-chat-session
// skill frontmatter mutations. The policy: heartbeat / cron / channel
// turns can still create new skills or edit the body, but must not be
// able to rewrite frontmatter — that's the admin's job, and a drift
// between stored credentials and declared envNames silently breaks auth.

import { describe, it, expect } from 'vitest';
import {
  frontmattersEqual,
  changedFrontmatterFields,
  isInteractiveSession,
} from '../../src/skills/frontmatter-diff.js';
import type { SkillFrontmatter } from '../../src/skills/frontmatter-schema.js';

function fm(overrides: Partial<SkillFrontmatter> = {}): SkillFrontmatter {
  return {
    name: 'linear',
    description: 'Query Linear',
    credentials: [{ envName: 'LINEAR_API_KEY', authType: 'api_key', scope: 'user' }],
    mcpServers: [
      {
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        transport: 'http',
        credential: 'LINEAR_API_KEY',
      },
    ],
    domains: ['mcp.linear.app'],
    ...overrides,
  };
}

describe('frontmattersEqual', () => {
  it('returns true for identical frontmatter (key-order-independent)', () => {
    expect(frontmattersEqual(fm(), fm())).toBe(true);
  });

  it('returns false when envName changes (the classic break)', () => {
    const before = fm();
    const after = fm({
      credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
    });
    expect(frontmattersEqual(before, after)).toBe(false);
  });

  it('returns false when authType flips from api_key to oauth', () => {
    const before = fm();
    const after = fm({
      credentials: [{
        envName: 'LINEAR_API_KEY',
        authType: 'oauth',
        scope: 'user',
        oauth: {
          provider: 'linear',
          clientId: 'cid',
          authorizationUrl: 'https://linear.app/oauth/authorize',
          tokenUrl: 'https://api.linear.app/oauth/token',
          scopes: [],
        },
      }],
    });
    expect(frontmattersEqual(before, after)).toBe(false);
  });

  it('returns false when MCP URL or transport changes', () => {
    expect(
      frontmattersEqual(fm(), fm({
        mcpServers: [{
          name: 'linear',
          url: 'https://mcp.linear.app/sse',
          transport: 'sse',
          credential: 'LINEAR_API_KEY',
        }],
      })),
    ).toBe(false);
  });

  it('returns false when domains array differs', () => {
    expect(
      frontmattersEqual(fm(), fm({ domains: ['mcp.linear.app', 'api.linear.app'] })),
    ).toBe(false);
  });

  it('returns true when optional fields differ only by undefined vs absent', () => {
    // YAML serialization drops undefined fields; canonicalize should too
    // so a YAML round-trip doesn't falsely flag a diff.
    const a = fm({ source: undefined });
    const b = fm();
    expect(frontmattersEqual(a, b)).toBe(true);
  });
});

describe('changedFrontmatterFields', () => {
  it('names the exact fields that drifted', () => {
    const before = fm();
    const after = fm({
      credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
      domains: ['different.example.com'],
    });
    expect(changedFrontmatterFields(before, after)).toEqual(['credentials', 'domains']);
  });

  it('returns an empty array when nothing changed', () => {
    expect(changedFrontmatterFields(fm(), fm())).toEqual([]);
  });

  it('reports name / description changes too (not just the MCP-auth-adjacent fields)', () => {
    const before = fm();
    const after = fm({ name: 'linear-v2', description: 'something else' });
    expect(changedFrontmatterFields(before, after)).toEqual(['name', 'description']);
  });
});

describe('isInteractiveSession', () => {
  it('recognizes http: (chat UI) sessions', () => {
    expect(isInteractiveSession('http:dm:agent:local123:user456')).toBe(true);
    expect(isInteractiveSession('http:dm:ax:X:Y')).toBe(true);
  });

  it('rejects scheduler / cron / heartbeat / channel sessions', () => {
    expect(isInteractiveSession('scheduler:dm:agent:cron-job-123')).toBe(false);
    expect(isInteractiveSession('slack:channel:workspace:C123')).toBe(false);
    expect(isInteractiveSession('webhook:dm:agent:peer')).toBe(false);
  });

  it('rejects undefined or empty sessionId — fail closed', () => {
    expect(isInteractiveSession(undefined)).toBe(false);
    expect(isInteractiveSession('')).toBe(false);
  });
});
