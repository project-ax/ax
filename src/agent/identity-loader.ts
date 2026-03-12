import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../logger.js';
import type { IdentityFiles } from './prompt/types.js';

const logger = getLogger().child({ component: 'identity-loader' });

/** Maximum characters for any single identity file (same as OpenClaw). */
const DEFAULT_MAX_CHARS = 65536;

function readFile(dir: string, filename: string): string {
  try {
    return readFileSync(join(dir, filename), 'utf-8');
  } catch {
    return '';
  }
}

/** Truncate identity file content if it exceeds the character cap. */
function capContent(content: string, fileName: string): string {
  if (!content || content.length <= DEFAULT_MAX_CHARS) return content;
  logger.warn('identity_file_truncated', {
    file: fileName,
    originalLength: content.length,
    maxChars: DEFAULT_MAX_CHARS,
  });
  return content.slice(0, DEFAULT_MAX_CHARS);
}

export interface IdentityLoadOptions {
  /** ~/.ax/agents/<name>/ directory containing all identity files */
  agentDir?: string;
  /** User ID for per-user USER.md loading */
  userId?: string;
  /**
   * Enterprise: explicit identity directory (overrides agentDir for identity files).
   * Maps to ~/.ax/agents/<agentId>/agent/ which contains SOUL.md, IDENTITY.md, etc.
   */
  identityDir?: string;
  /**
   * Enterprise: explicit user directory (overrides agentDir/users/<userId>).
   * Maps to ~/.ax/agents/<agentId>/users/<userId>/.
   */
  userDir?: string;
  /**
   * USER_BOOTSTRAP.md content from host via stdin payload.
   * When provided, skips reading USER_BOOTSTRAP.md from disk (it's not in the sandbox mount).
   */
  userBootstrapContent?: string;
  /** Preloaded identity files from DB (via stdin payload). Takes precedence over filesystem. */
  preloaded?: Partial<IdentityFiles>;
}

export function loadIdentityFiles(opts: IdentityLoadOptions): IdentityFiles {
  const { agentDir, userId, preloaded } = opts;

  // Enterprise paths take precedence over legacy agentDir layout
  const idDir = opts.identityDir ?? agentDir;
  const load = (name: string) => idDir ? capContent(readFile(idDir, name), name) : '';

  // Helper: use preloaded content from DB (via stdin payload) when available,
  // falling back to filesystem read.
  const preloadOrRead = (field: keyof IdentityFiles, fileName: string): string => {
    const preloadedValue = preloaded?.[field];
    if (preloadedValue && preloadedValue.trim()) return capContent(preloadedValue, fileName);
    return load(fileName);
  };

  // USER.md is per-user: prefer preloaded, then explicit userDir, then agentDir/users/<userId>
  let user = '';
  if (preloaded?.user && preloaded.user.trim()) {
    user = capContent(preloaded.user, 'USER.md');
  } else if (opts.userDir) {
    user = capContent(readFile(opts.userDir, 'USER.md'), 'USER.md');
  } else if (agentDir && userId) {
    user = capContent(readFile(join(agentDir, 'users', userId), 'USER.md'), 'USER.md');
  }

  // USER_BOOTSTRAP.md is shown when the user has no USER.md yet.
  // Prefer preloaded, then host-provided content (via stdin payload),
  // then disk read — the file lives in agentConfigDir which is not in the sandbox mount.
  let userBootstrap = '';
  if (!user) {
    if (preloaded?.userBootstrap && preloaded.userBootstrap.trim()) {
      userBootstrap = capContent(preloaded.userBootstrap, 'USER_BOOTSTRAP.md');
    } else if (opts.userBootstrapContent) {
      userBootstrap = capContent(opts.userBootstrapContent, 'USER_BOOTSTRAP.md');
    } else if (idDir) {
      userBootstrap = capContent(readFile(idDir, 'USER_BOOTSTRAP.md'), 'USER_BOOTSTRAP.md');
    }
  }

  return {
    agents: preloadOrRead('agents', 'AGENTS.md'),
    soul: preloadOrRead('soul', 'SOUL.md'),
    identity: preloadOrRead('identity', 'IDENTITY.md'),
    user,
    bootstrap: preloadOrRead('bootstrap', 'BOOTSTRAP.md'),
    userBootstrap,
    heartbeat: preloadOrRead('heartbeat', 'HEARTBEAT.md'),
  };
}
