/**
 * Runtime asset resolvers — resolves project-root-relative paths using
 * import.meta.url so commands work from any working directory.
 *
 * provider-map.ts already does this right. This module applies the same
 * pattern to templates/, node_modules/.bin/tsx, and src/agent/runner.
 * Also provides seedSkillsDir() for first-run skill seeding from project root.
 *
 * Override with AX_TEMPLATES_DIR, AX_SKILLS_DIR, or AX_RUNNER_PATH
 * environment variables for non-standard layouts.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// This file is at src/utils/assets.ts → two levels up is the project root.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Are we running from TypeScript source (via tsx) rather than compiled JS?
 * When the host is started with `tsx src/cli/index.ts serve`, this file
 * resolves to src/utils/assets.ts. When started from dist/ it resolves
 * to dist/utils/assets.js.
 */
const DEV_MODE = import.meta.url.endsWith('.ts');

/** Absolute path to the templates/ directory. */
export function templatesDir(): string {
  return process.env.AX_TEMPLATES_DIR ?? join(PROJECT_ROOT, 'templates');
}

/** Absolute path to the seed skills/ directory (project root). Used for first-run seeding only. */
export function seedSkillsDir(): string {
  return process.env.AX_SKILLS_DIR ?? join(PROJECT_ROOT, 'skills');
}

/** Absolute path to the tsx binary (legacy — kept for backwards compat with AX_TSX_BIN env). */
export function tsxBin(): string {
  return process.env.AX_TSX_BIN ?? join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
}

/**
 * Absolute path to the tsx ESM loader, for dev-mode agent spawning.
 * Used with `node --import <loader>` so agents can run .ts source directly.
 * Must be an absolute path because agents run with cwd=workspace (a temp dir
 * that has no node_modules).
 */
export function tsxLoader(): string {
  return join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
}

/**
 * Absolute path to the agent runner entry point.
 *
 * In dev mode (host running via tsx): src/agent/runner.ts — uses tsx ESM
 * loader so source changes are picked up without rebuilding.
 *
 * In production (host running from dist/): dist/agent/runner.js — plain
 * compiled JS, no tsx dependency, no extra process layers.
 */
export function runnerPath(): string {
  if (process.env.AX_RUNNER_PATH) return process.env.AX_RUNNER_PATH;
  return DEV_MODE
    ? join(PROJECT_ROOT, 'src', 'agent', 'runner.ts')
    : join(PROJECT_ROOT, 'dist', 'agent', 'runner.js');
}

/** Whether the host is running in dev mode (from TypeScript source). */
export function isDevMode(): boolean {
  return DEV_MODE;
}
