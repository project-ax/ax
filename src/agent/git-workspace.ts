/**
 * Git workspace operations for agent persistence.
 *
 * Handles cloning, initialization, and committing+pushing agent state
 * to a remote repository using native git CLI (supports LFS).
 */

import { getLogger } from '../logger.js';
import { gitClone, gitCheckout, gitConfig, gitExec, gitAdd, gitStatus, gitCommit, gitPush } from './git-cli.js';

const logger = getLogger().child({ component: 'git-workspace' });

/**
 * Manages git operations for agent workspace — clone, init, commit+push.
 * Uses HTTP transport via native git binary.
 */
export class GitWorkspace {
  private workspaceDir: string;
  private repoUrl: string;

  constructor(workspaceDir: string, repoUrl: string) {
    this.workspaceDir = workspaceDir;
    this.repoUrl = repoUrl;
  }

  /**
   * Clone the workspace repository.
   * For empty repositories, ensures we have a local main branch to commit to.
   */
  async clone(): Promise<void> {
    try {
      logger.debug('git_clone_start', {
        workspaceDir: this.workspaceDir,
        url: this.repoUrl,
      });

      await gitClone(this.repoUrl, this.workspaceDir);
      logger.info('git_cloned', { workspaceDir: this.workspaceDir, url: this.repoUrl });

      // Ensure main branch is checked out
      try {
        await gitCheckout('main', { cwd: this.workspaceDir });
      } catch {
        logger.warn('checkout_main_failed', { workspaceDir: this.workspaceDir });
      }
    } catch (err) {
      logger.error('git_clone_failed', { error: (err as Error).message, url: this.repoUrl });
      throw err;
    }
  }

  /**
   * Initialize git config (user.name and user.email).
   * Required before committing. Safe to call multiple times.
   */
  async init(): Promise<void> {
    try {
      const opts = { cwd: this.workspaceDir };
      await gitConfig('user.name', 'agent', opts);
      await gitConfig('user.email', 'agent@ax.local', opts);
      logger.info('git_config_initialized', { workspaceDir: this.workspaceDir });
    } catch (err) {
      logger.error('git_config_init_failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Pull latest changes from origin/main.
   * Called at the start of each turn to get changes from concurrent sessions.
   * Gracefully handles merge conflicts and fast-forward failures.
   */
  async pull(): Promise<void> {
    try {
      logger.debug('git_pull_start', { workspaceDir: this.workspaceDir });
      await gitExec(['pull', 'origin', 'main'], { cwd: this.workspaceDir });
      logger.info('git_pulled', { workspaceDir: this.workspaceDir });
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      logger.warn('git_pull_failed', { error: errMsg });
    }
  }

  /**
   * Stage all changes, commit, and push to origin/main.
   * If there are no changes, logs a debug message and returns without error.
   * Push failures are logged but don't throw (allows graceful degradation).
   */
  async commitAndPush(message: string): Promise<void> {
    try {
      const opts = { cwd: this.workspaceDir };

      await gitAdd(opts);

      const changed = await gitStatus(opts);
      if (changed.length === 0) {
        logger.debug('git_no_changes', { message, stagedCount: 0 });
        return;
      }

      const hash = await gitCommit(message, opts);
      logger.info('git_committed', { hash, message, stagedCount: changed.length });

      try {
        await gitPush(opts);
        logger.info('git_pushed', { hash, message });
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        logger.warn('git_push_failed', { error: errMsg, message });
      }
    } catch (err) {
      logger.error('git_commit_push_failed', { error: (err as Error).message, message });
      throw err;
    }
  }
}
