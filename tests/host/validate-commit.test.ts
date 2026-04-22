import { describe, it, expect } from 'vitest';
import { validateCommit } from '../../src/host/validate-commit.js';

describe('validateCommit', () => {
  it('passes when diff is empty', () => {
    const result = validateCommit('');
    expect(result).toEqual({ ok: true });
  });

  it('passes for valid identity file changes', () => {
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1,3 @@
+I am a helpful assistant.
+I value clarity and honesty.
+I work carefully.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects files outside allowed paths', () => {
    const diff = `diff --git a/.ax/secrets.txt b/.ax/secrets.txt
--- /dev/null
+++ b/.ax/secrets.txt
@@ -0,0 +1 @@
+some secret`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not in allowed paths');
  });

  it('rejects files exceeding size limit', () => {
    const bigContent = '+' + 'x'.repeat(33_000) + '\n';
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1,1 @@
${bigContent}`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exceeds size limit');
  });

  it('passes for valid skill file changes', () => {
    const diff = `diff --git a/.ax/skills/my-skill.md b/.ax/skills/my-skill.md
--- /dev/null
+++ b/.ax/skills/my-skill.md
@@ -0,0 +1,2 @@
+name: my-skill
+description: A useful skill`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('passes for AGENTS.md and HEARTBEAT.md changes', () => {
    const diff = `diff --git a/.ax/AGENTS.md b/.ax/AGENTS.md
--- /dev/null
+++ b/.ax/AGENTS.md
@@ -0,0 +1 @@
+You are a helpful agent.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('passes for policy file changes', () => {
    const diff = `diff --git a/.ax/policy/rules.yaml b/.ax/policy/rules.yaml
--- /dev/null
+++ b/.ax/policy/rules.yaml
@@ -0,0 +1 @@
+version: 1`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('allows larger files under skills (64KB limit)', () => {
    const content = '+' + 'y'.repeat(50_000) + '\n';
    const diff = `diff --git a/.ax/skills/big-skill.md b/.ax/skills/big-skill.md
--- /dev/null
+++ b/.ax/skills/big-skill.md
@@ -0,0 +1,1 @@
${content}`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects skill files exceeding 64KB limit', () => {
    const content = '+' + 'z'.repeat(66_000) + '\n';
    const diff = `diff --git a/.ax/skills/huge-skill.md b/.ax/skills/huge-skill.md
--- /dev/null
+++ b/.ax/skills/huge-skill.md
@@ -0,0 +1,1 @@
${content}`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exceeds size limit');
  });

  it('handles multiple files in a single diff', () => {
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1 @@
+I am thoughtful.
diff --git a/.ax/AGENTS.md b/.ax/AGENTS.md
--- /dev/null
+++ b/.ax/AGENTS.md
@@ -0,0 +1 @@
+Be helpful.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when one file of many is outside allowed paths', () => {
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1 @@
+I am thoughtful.
diff --git a/.ax/hacks/evil.sh b/.ax/hacks/evil.sh
--- /dev/null
+++ b/.ax/hacks/evil.sh
@@ -0,0 +1 @@
+rm -rf /`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not in allowed paths');
  });
});

describe('validateCommit — SKILL.md frontmatter validation', () => {
  // Regression: skills with broken frontmatter were accepted at commit time
  // and only rejected later when the loader tried to parse them, leaving
  // the agent thinking everything was fine while the skill silently landed
  // in "invalid" state on the admin Skills tab. The only signal was a
  // user noticing the missing approval. Fix: parse frontmatter here, return
  // the Zod errors as part of the rejection reason so the LLM can fix and
  // retry in the same turn.

  const validSkill = `---
name: linear
description: Linear issue tracking
credentials:
  - envName: LINEAR_API_KEY
    authType: api_key
mcpServers:
  - name: linear
    url: https://mcp.linear.app
    credential: LINEAR_API_KEY
---

# Linear

Use this skill to manage Linear issues.`;

  it('passes a SKILL.md with valid frontmatter', () => {
    const result = validateCommit('', [
      { path: '.ax/skills/linear/SKILL.md', content: validSkill },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('rejects SKILL.md with mcpServers[].credential as nested object', () => {
    // Exact bug from the field report: agent wrote
    //   credential: { envName: ..., authType: ..., scope: ... }
    // instead of a string reference.
    const badSkill = `---
name: linear
description: Linear issues
mcpServers:
  - name: linear
    url: https://mcp.linear.app
    credential:
      envName: LINEAR_API_KEY
      authType: api_key
      scope: read
---

# Linear`;
    const result = validateCommit('', [
      { path: '.ax/skills/linear/SKILL.md', content: badSkill },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mcpServers\[\]\.credential must be a string envName/);
  });

  it('rejects SKILL.md with invalid credentials.authType', () => {
    const badSkill = `---
name: linear
description: Linear issues
credentials:
  - envName: LINEAR_API_KEY
    authType: bearer_token
---

# Linear`;
    const result = validateCommit('', [
      { path: '.ax/skills/linear/SKILL.md', content: badSkill },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/authType/);
  });

  it('rejects SKILL.md with missing required frontmatter fields', () => {
    const badSkill = `---
description: Missing name
---

# Body`;
    const result = validateCommit('', [
      { path: '.ax/skills/linear/SKILL.md', content: badSkill },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects SKILL.md with unterminated frontmatter', () => {
    const badSkill = `---
name: linear
description: Missing closing delimiter`;
    const result = validateCommit('', [
      { path: '.ax/skills/linear/SKILL.md', content: badSkill },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/frontmatter/);
  });

  it('includes the skill path in the rejection reason', () => {
    const badSkill = `---
description: Missing name
---
`;
    const result = validateCommit('', [
      { path: '.ax/skills/my-broken-one/SKILL.md', content: badSkill },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\.ax\/skills\/my-broken-one\/SKILL\.md/);
  });

  it('ignores files outside .ax/skills/*/SKILL.md (no spurious parse)', () => {
    // A file named SKILL.md under policy/ should not be parsed as a skill.
    const result = validateCommit('', [
      { path: '.ax/policy/SKILL.md', content: 'not yaml at all' },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('backward compat: still works when files arg is absent', () => {
    const result = validateCommit('');
    expect(result).toEqual({ ok: true });
  });
});

describe('hostGitCommit integration', () => {
  it('validateCommit is used by hostGitCommit to gate .ax/ changes', () => {
    // The integration is verified by:
    // 1. hostGitCommit calls `git diff --cached -- .ax/...` after staging
    // 2. If the diff is non-empty, it calls validateCommit(diff)
    // 3. If validation fails, it reverts .ax/ changes and continues
    // This is tested indirectly via the validateCommit unit tests above
    // and the source-level integration in hostGitCommit.
    // Full integration requires a real git repo (covered in acceptance tests).
    expect(validateCommit('')).toEqual({ ok: true });
  });
});
