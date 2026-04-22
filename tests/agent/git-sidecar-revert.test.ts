// Regression test for the git-sidecar .ax/ revert logic.
//
// The sidecar's commit path stages everything, validates the .ax/ portion
// against the host's frontmatter schema, and — on rejection — attempts to
// "revert" so the bad file doesn't land. Historically the revert was:
//   git reset HEAD -- .ax/
//   git checkout -- .ax/
// which works for MODIFIED tracked files but is a silent no-op for NEW
// untracked files. The subsequent `git add -A` re-stages them, so brand-new
// skills with invalid frontmatter got committed anyway and the admin UI's
// reconciler parsed them as "invalid" with the Zod error text. This test
// reproduces the failure mode and pins the fix (adding `git clean -fd`).
//
// Real git in a tmp worktree — no mocks. The bug is specifically about git
// command behavior, so substituting a mock would hide it.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { revertAxChanges } from '../../src/agent/git-sidecar.js';
import { initLogger } from '../../src/logger.js';

initLogger({ level: 'silent', file: false });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('git-sidecar revertAxChanges', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ax-sidecar-revert-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@test.com');
    git(repo, 'config', 'user.name', 'test');
    // Base commit so HEAD exists.
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('removes brand-new untracked .ax/ files (regression)', async () => {
    // Simulate: agent wrote a NEW skill with invalid frontmatter, which got
    // staged by the sidecar's initial `git add -A`.
    mkdirSync(join(repo, '.ax', 'skills', 'linear'), { recursive: true });
    writeFileSync(join(repo, '.ax', 'skills', 'linear', 'SKILL.md'), '---\nname: linear\n---\n');
    git(repo, 'add', '-A');
    expect(git(repo, 'status', '--short')).toContain('A  .ax/skills/linear/SKILL.md');

    // Revert
    await revertAxChanges({ gitDir: join(repo, '.git'), workTree: repo });

    // The file must be GONE — not just unstaged.
    expect(existsSync(join(repo, '.ax', 'skills', 'linear', 'SKILL.md'))).toBe(false);
    expect(git(repo, 'status', '--short')).toBe('');
  });

  test('restores modifications to tracked .ax/ files without touching them on disk as new', async () => {
    // Seed a committed skill in the repo.
    mkdirSync(join(repo, '.ax', 'skills', 'existing'), { recursive: true });
    writeFileSync(
      join(repo, '.ax', 'skills', 'existing', 'SKILL.md'),
      '---\nname: existing\ndescription: ok\n---\n',
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'seed existing skill');

    // Simulate: agent modified an existing skill with broken frontmatter.
    writeFileSync(
      join(repo, '.ax', 'skills', 'existing', 'SKILL.md'),
      '---\nname: existing\n---\n', // description removed → invalid
    );
    git(repo, 'add', '-A');

    await revertAxChanges({ gitDir: join(repo, '.git'), workTree: repo });

    // File restored to the committed (valid) version.
    const restored = execFileSync('cat', [join(repo, '.ax', 'skills', 'existing', 'SKILL.md')], { encoding: 'utf-8' });
    expect(restored).toContain('description: ok');
    expect(git(repo, 'status', '--short')).toBe('');
  });

  test('leaves non-.ax/ changes untouched', async () => {
    writeFileSync(join(repo, 'app.js'), 'console.log(1)\n');
    mkdirSync(join(repo, '.ax', 'skills', 'bad'), { recursive: true });
    writeFileSync(join(repo, '.ax', 'skills', 'bad', 'SKILL.md'), '---\nbroken\n---\n');
    git(repo, 'add', '-A');

    await revertAxChanges({ gitDir: join(repo, '.git'), workTree: repo });

    // .ax/ gone, app.js still staged.
    expect(existsSync(join(repo, '.ax', 'skills', 'bad'))).toBe(false);
    expect(existsSync(join(repo, 'app.js'))).toBe(true);
    const status = git(repo, 'status', '--short');
    expect(status).toContain('A  app.js');
    expect(status).not.toContain('.ax/');
  });

  test('is a no-op when .ax/ has nothing staged or untracked', async () => {
    // Control case — the catch blocks should swallow "nothing to reset"
    // errors silently.
    await expect(revertAxChanges({ gitDir: join(repo, '.git'), workTree: repo })).resolves.toBeUndefined();
    expect(git(repo, 'status', '--short')).toBe('');
  });
});
