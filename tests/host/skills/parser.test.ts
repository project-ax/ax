import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '../../../src/skills/parser.js';

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

  it('includes the received value in error messages for camelCase authType', () => {
    // Regression: Zod's default "Invalid option: expected one of api_key|oauth"
    // tells the agent the valid values but not what it actually wrote. Agents
    // saw the error, couldn't match it to their own output, and gave up.
    const content = `---
name: linear
description: x
credentials:
  - envName: LINEAR_API_KEY
    authType: apiKey
---
body`;
    const result = parseSkillFile(content);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('credentials.0.authType');
    expect(result.error).toContain('received: "apiKey"');
  });

  it('omits "received" for missing required fields (undefined carries no signal)', () => {
    const content = '---\nname: x\n---\nbody';
    const result = parseSkillFile(content);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // "expected string, received undefined" from Zod already says it all.
    expect(result.error).toContain('description:');
    expect(result.error).not.toContain('(received: undefined)');
  });

  it('renders received objects compactly for nested-shape mistakes', () => {
    // Agents sometimes nest {envName, authType, scope} inside
    // mcpServers[].credential (a string field). The custom Zod message
    // already explains the fix; "received: { ... }" confirms what was written.
    const content = `---
name: x
description: y
mcpServers:
  - name: svc
    url: https://svc.test/mcp
    credential:
      envName: FOO
      authType: api_key
      scope: user
---
body`;
    const result = parseSkillFile(content);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('mcpServers.0.credential');
    expect(result.error).toContain('received:');
    expect(result.error).toContain('"envName":"FOO"');
  });
});
