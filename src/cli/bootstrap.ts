import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';
import type { WorkspaceProvider } from '../providers/workspace/types.js';
import { readIdentityForAgent } from '../host/identity-reader.js';

/**
 * Reset an agent's identity by removing SOUL.md and IDENTITY.md from the git repo.
 * The next session will enter bootstrap mode (no soul or identity = bootstrap).
 */
export async function resetAgent(agentName: string, workspace: WorkspaceProvider): Promise<void> {
  const { url: repoUrl } = await workspace.getRepoUrl(agentName);

  if (repoUrl.startsWith('file://')) {
    // file:// — commit deletion directly to the bare repo via a temp worktree
    const bareRepoPath = repoUrl.replace('file://', '');
    const gitOpts = { cwd: bareRepoPath, stdio: 'pipe' as const };
    // Remove identity files from the index (bare repo, no worktree needed)
    for (const file of ['.ax/SOUL.md', '.ax/IDENTITY.md']) {
      try { execFileSync('git', ['rm', '--cached', '--ignore-unmatch', file], gitOpts); } catch { /* may not exist */ }
    }
    try {
      const status = execFileSync('git', ['status', '--porcelain'], { ...gitOpts, encoding: 'utf-8' }).trim();
      if (status) {
        execFileSync('git', ['commit', '-m', 'bootstrap: reset identity'], gitOpts);
      }
    } catch { /* nothing to commit */ }
  } else {
    // http:// — would need a temp clone to commit. For now, log guidance.
    console.log('For HTTP repos: delete .ax/SOUL.md and .ax/IDENTITY.md in the agent workspace and commit.');
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
