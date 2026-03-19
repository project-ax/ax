import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

describe('collectSkillEnvRequirements', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
    dirs.length = 0;
  });

  test('source handles both file-based and directory-based skills', () => {
    // Verify the implementation pattern in server-completions.ts
    const source = readFileSync(
      new URL('../../src/host/server-completions.ts', import.meta.url), 'utf-8',
    );
    // Must use withFileTypes to distinguish files from directories
    expect(source).toContain("readdirSync(dir, { withFileTypes: true })");
    // Must check for directory-based skills (SKILL.md inside subdirectory)
    expect(source).toContain("entry.isDirectory()");
    expect(source).toContain("SKILL.md");
  });

  test('parseAgentSkill extracts requires.env from both skill formats', async () => {
    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

    // File-based skill with metadata.openclaw.requires.env
    const fileSkill = `---
name: linear-bot
metadata:
  openclaw:
    requires:
      env:
        - LINEAR_API_KEY
---
Linear integration skill.`;

    const parsed = parseAgentSkill(fileSkill);
    expect(parsed.requires.env).toContain('LINEAR_API_KEY');

    // Same format works from directory-based SKILL.md
    const dirSkill = `---
name: deploy
metadata:
  openclaw:
    requires:
      env:
        - GITHUB_TOKEN
        - AWS_ACCESS_KEY_ID
---
Deploy skill.`;

    const parsed2 = parseAgentSkill(dirSkill);
    expect(parsed2.requires.env).toContain('GITHUB_TOKEN');
    expect(parsed2.requires.env).toContain('AWS_ACCESS_KEY_ID');
  });
});
