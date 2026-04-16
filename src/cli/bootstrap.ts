import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';
import type { WorkspaceProvider } from '../providers/workspace/types.js';
import { readIdentityForAgent } from '../host/identity-reader.js';

/**
 * Reset an agent's identity by removing SOUL.md and IDENTITY.md from the git repo.
 * The next session will enter bootstrap mode (no soul or identity = bootstrap).
 */
export async function resetAgent(agentName: string, workspace: WorkspaceProvider): Promise<void> {
  const { url: repoUrl } = await workspace.getRepoUrl(agentName);

  // Temp clone → delete identity files → commit → push → cleanup.
  // Works for both file:// and http:// repos.
  const tmpWs = mkdtempSync(join(tmpdir(), 'ax-reset-ws-'));
  try {
    execFileSync('git', ['clone', repoUrl, tmpWs], { stdio: 'pipe' });
    const gitOpts = { cwd: tmpWs, stdio: 'pipe' as const };
    execFileSync('git', ['config', 'user.email', 'ax-host@ax.local'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'ax-host'], gitOpts);
    for (const file of ['.ax/SOUL.md', '.ax/IDENTITY.md']) {
      try { execFileSync('git', ['rm', '--ignore-unmatch', file], gitOpts); } catch { /* may not exist */ }
    }
    const status = execFileSync('git', ['status', '--porcelain'], { ...gitOpts, encoding: 'utf-8' }).trim();
    if (status) {
      execFileSync('git', ['commit', '-m', 'bootstrap: reset identity'], gitOpts);
      execFileSync('git', ['push', 'origin', 'main'], gitOpts);
    }
  } catch { /* empty repo or nothing to reset */ } finally {
    try { rmSync(tmpWs, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0];
  if (!agentName) {
    console.error('Error: agent name required. Usage: ax bootstrap <agent-name>');
    process.exit(1);
  }
  const templatesDir = resolveTemplatesDir();

  if (!existsSync(templatesDir)) {
    console.error(`Templates directory not found: ${templatesDir}`);
    process.exit(1);
  }

  const { loadConfig } = await import('../config.js');
  const { loadProviders } = await import('../host/registry.js');
  const config = loadConfig();
  const providers = await loadProviders(config);

  if (!providers.workspace) {
    console.error('No workspace provider configured.');
    process.exit(1);
  }

  try {
    const identity = await readIdentityForAgent(agentName, providers.workspace);
    if (identity.soul) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question(
          `This will erase ${agentName}'s personality and start fresh. Continue? (y/N) `,
          resolve,
        );
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        return;
      }
    }

    await resetAgent(agentName, providers.workspace);
    console.log(`[bootstrap] Reset complete. Run 'ax serve' and open the admin dashboard to begin the bootstrap ritual.`);
  } finally {
    try { providers.storage.close(); } catch { /* ignore */ }
  }
}
