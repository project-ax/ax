/**
 * Canonical sandbox paths — simple, consistent paths for agent containers.
 *
 * Instead of mounting host directories at their real paths (leaking structure
 * like /home/alice/.ax/data/workspaces/main/cli/default/), sandbox providers
 * remap mounts to these short canonical paths. The LLM sees /scratch instead
 * of a deeply-nested host path, regardless of sandbox type.
 *
 * Canonical mount table (all under /workspace, which is the CWD):
 *   /workspace          — CWD/HOME (mount root)
 *   /workspace/scratch  — Session working files (rw, lost when session ends)
 *   /workspace/skills   — Merged agent + user skills (overlayfs, ro)
 *   /workspace/identity — Agent identity files: SOUL.md, etc. (ro)
 *   /workspace/agent    — Agent workspace, persistent shared files (ro)
 *   /workspace/user     — Per-user persistent storage (ro, writes via IPC)
 *
 * Providers that support filesystem remapping (Docker, bwrap, nsjail) mount
 * directly to canonical paths. Providers that don't (seatbelt, subprocess)
 * create symlinks under /tmp and set env vars to the symlink paths.
 */

import { mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxConfig } from './types.js';

/** Canonical paths inside the sandbox — what the LLM sees. */
export const CANONICAL = {
  root:     '/workspace',
  scratch:  '/workspace/scratch',
  skills:   '/workspace/skills',
  identity: '/workspace/identity',
  agent:    '/workspace/agent',
  user:     '/workspace/user',
} as const;

/**
 * Build the canonical environment variables for sandbox providers.
 * IPC socket stays at its real host path (not agent-visible, needed by both sides).
 */
export function canonicalEnv(config: SandboxConfig): Record<string, string> {
  return {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: CANONICAL.root,
    AX_SKILLS: CANONICAL.skills,
    ...(config.agentDir        ? { AX_AGENT_DIR: CANONICAL.identity } : {}),
    ...(config.agentWorkspace  ? { AX_AGENT_WORKSPACE: CANONICAL.agent } : {}),
    ...(config.userWorkspace   ? { AX_USER_WORKSPACE: CANONICAL.user } : {}),
    // Redirect caches to /tmp so they don't pollute workspace
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
}

/**
 * Create symlinks from canonical names to real host paths under a temp directory.
 *
 * Used by providers that can't remap filesystems (seatbelt, subprocess).
 * Returns the mount root (e.g. /tmp/.ax-mounts-<uuid>) and a cleanup function.
 */
export function createCanonicalSymlinks(config: SandboxConfig): {
  mountRoot: string;
  cleanup: () => void;
} {
  const mountRoot = join('/tmp', `.ax-mounts-${randomUUID().slice(0, 8)}`);
  mkdirSync(mountRoot, { recursive: true });

  // scratch → real workspace (session cwd/HOME)
  symlinkSync(config.workspace, join(mountRoot, 'scratch'));

  // skills → real skills dir (merged via overlayfs on host, or single dir)
  symlinkSync(config.skills, join(mountRoot, 'skills'));

  // identity → real agentDir (identity files)
  if (config.agentDir) {
    symlinkSync(config.agentDir, join(mountRoot, 'identity'));
  }

  // agent → agent workspace (read-only)
  if (config.agentWorkspace) {
    symlinkSync(config.agentWorkspace, join(mountRoot, 'agent'));
  }

  // user → per-user persistent workspace (read-only in sandbox, writes via IPC)
  if (config.userWorkspace) {
    symlinkSync(config.userWorkspace, join(mountRoot, 'user'));
  }

  return {
    mountRoot,
    cleanup: () => {
      try {
        if (existsSync(mountRoot)) {
          rmSync(mountRoot, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup — /tmp will handle the rest
      }
    },
  };
}

/**
 * Build the symlink-based environment variables for providers that can't remap.
 * Points to symlink paths under mountRoot instead of real host paths.
 */
export function symlinkEnv(config: SandboxConfig, mountRoot: string): Record<string, string> {
  return {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: mountRoot,
    AX_SKILLS: join(mountRoot, 'skills'),
    ...(config.agentDir        ? { AX_AGENT_DIR: join(mountRoot, 'identity') } : {}),
    ...(config.agentWorkspace  ? { AX_AGENT_WORKSPACE: join(mountRoot, 'agent') } : {}),
    ...(config.userWorkspace   ? { AX_USER_WORKSPACE: join(mountRoot, 'user') } : {}),
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
}

/**
 * Merge agent-level and user-level skills into a single directory using overlayfs.
 *
 * The merged view is read-only — writes go through the skills_propose IPC action
 * on the host side. Agent skills form the lower layer; user skills form the upper
 * layer, so user skills shadow agent skills of the same name.
 *
 * Falls back to a plain directory when overlayfs is unavailable (macOS,
 * unprivileged Linux). In fallback mode, only agent-level skills are visible.
 *
 * @returns The path to the merged skills directory and a cleanup function.
 */
export function mergeSkillsOverlay(agentSkillsDir: string, userSkillsDir: string): {
  mergedDir: string;
  cleanup: () => void;
} {
  const id = randomUUID().slice(0, 8);
  const mergedDir = join('/tmp', `.ax-skills-merged-${id}`);
  const workDir = join('/tmp', `.ax-skills-work-${id}`);

  mkdirSync(mergedDir, { recursive: true });
  mkdirSync(agentSkillsDir, { recursive: true });
  mkdirSync(userSkillsDir, { recursive: true });

  // Try overlayfs mount (requires privileges or user namespace support)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    mkdirSync(workDir, { recursive: true });

    // overlayfs: lower=agent (base), upper=user (overrides).
    // User skills shadow agent skills of the same name.
    execFileSync('mount', [
      '-t', 'overlay', 'overlay',
      '-o', `lowerdir=${agentSkillsDir},upperdir=${userSkillsDir},workdir=${workDir}`,
      mergedDir,
    ], { stdio: 'ignore' });

    return {
      mergedDir,
      cleanup: () => {
        try {
          const { execFileSync: unmount } = require('node:child_process') as typeof import('node:child_process');
          unmount('umount', [mergedDir], { stdio: 'ignore' });
        } catch { /* best-effort */ }
        try { rmSync(mergedDir, { recursive: true, force: true }); } catch { /* */ }
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
      },
    };
  } catch {
    // Fallback: no overlayfs support — just use agent skills dir directly.
    // User-level skills won't be visible in the sandbox in this mode.
    // The skill store provider on the host side still manages both layers via IPC.
    rmSync(mergedDir, { recursive: true, force: true });

    return {
      mergedDir: agentSkillsDir,
      cleanup: () => {
        // Nothing to clean up in fallback mode
      },
    };
  }
}
