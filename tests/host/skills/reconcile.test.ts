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
