/**
 * Native git CLI wrapper for workspace operations.
 *
 * Uses execFile (no shell) to prevent command injection.
 * Supports separate gitdir via GIT_DIR/GIT_WORK_TREE env vars
 * for the sidecar pattern where .git metadata lives on a
 * volume the agent cannot access.
 */

import { execFile } from 'node:child_process';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'git-cli' });

export interface GitOpts {
  /** Path to .git directory (sets GIT_DIR env var) */
  gitDir?: string;
  /** Path to working tree (sets GIT_WORK_TREE env var) */
  workTree?: string;
  /** Working directory for the command */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Branch name (default: 'main') */
  branch?: string;
}

/**
 * Execute a git command via native CLI. Uses execFile (no shell) to prevent injection.
 * Supports separate gitdir via GIT_DIR/GIT_WORK_TREE env vars.
 */
export async function gitExec(args: string[], opts?: GitOpts): Promise<string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: '0',
    ...opts?.env,
  };
  if (opts?.gitDir) env.GIT_DIR = opts.gitDir;
  if (opts?.workTree) env.GIT_WORK_TREE = opts.workTree;

  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts?.cwd, env, maxBuffer: 10 * 1024 * 1024, timeout: opts?.timeoutMs ?? 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        logger.debug('git_error', { subcommand: args[0], code: (err as NodeJS.ErrnoException).code, stderr: msg });
        reject(new Error(`git ${args[0]} failed: ${msg}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function gitClone(
  url: string,
  dir: string,
  opts?: GitOpts & { separateGitDir?: string },
): Promise<void> {
  const args = ['clone'];
  if (opts?.separateGitDir) args.push('--separate-git-dir', opts.separateGitDir);
  args.push(url, dir);
  await gitExec(args, opts);
}

export async function gitFetch(opts: GitOpts): Promise<void> {
  await gitExec(['fetch', 'origin'], opts);
}

export async function gitResetHard(ref: string, opts: GitOpts): Promise<void> {
  await gitExec(['reset', '--hard', ref], opts);
}

export async function gitCheckout(ref: string, opts: GitOpts): Promise<void> {
  await gitExec(['checkout', ref], opts);
}

/** Stage all changes (adds, modifications, and deletions). */
export async function gitAdd(opts: GitOpts): Promise<void> {
  await gitExec(['add', '-A'], opts);
}

/** Returns list of changed file paths from `git status --porcelain`. */
export async function gitStatus(opts: GitOpts): Promise<string[]> {
  const out = await gitExec(['status', '--porcelain'], opts);
  return out.trim() ? out.trim().split('\n') : [];
}

/** Commit staged changes, returns the commit hash. */
export async function gitCommit(message: string, opts: GitOpts): Promise<string> {
  await gitExec(
    ['-c', 'user.name=agent', '-c', 'user.email=agent@ax.local', 'commit', '-m', message],
    opts,
  );
  const out = await gitExec(['rev-parse', 'HEAD'], opts);
  return out.trim();
}

export async function gitPush(opts: GitOpts & { force?: boolean }): Promise<void> {
  const branch = opts.branch ?? 'main';
  const args = ['push', 'origin', branch];
  if (opts.force) args.push('--force');
  await gitExec(args, opts);
}

export async function gitConfig(key: string, value: string, opts: GitOpts): Promise<void> {
  await gitExec(['config', key, value], opts);
}

/** Remove untracked files and directories. */
export async function gitClean(opts: GitOpts): Promise<void> {
  await gitExec(['clean', '-fd'], opts);
}
