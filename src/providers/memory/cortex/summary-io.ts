// src/providers/memory/cortex/summary-io.ts — Read/write category summary .md files
import { readFile, writeFile, rename, access, readdir, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safePath } from '../../../utils/safe-path.js';
import { DEFAULT_CATEGORIES } from './types.js';

/**
 * Resolve the summary directory for a given userId.
 * Shared (agent-wide) summaries live in memoryDir directly.
 * User-scoped summaries live in memoryDir/users/<userId>/.
 */
function summaryDir(memoryDir: string, userId?: string): string {
  if (!userId) return memoryDir;
  return safePath(safePath(memoryDir, 'users'), userId);
}

/**
 * Write a category summary .md file atomically (temp -> rename).
 *
 * Uses safePath() for all path construction to prevent traversal.
 * Atomic via write-to-temp-then-rename so readers never see partial files.
 */
export async function writeSummary(
  memoryDir: string,
  category: string,
  content: string,
  userId?: string,
): Promise<void> {
  const dir = summaryDir(memoryDir, userId);
  const filePath = safePath(dir, `${category}.md`);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Read a category summary. Returns null if file doesn't exist.
 */
export async function readSummary(
  memoryDir: string,
  category: string,
  userId?: string,
): Promise<string | null> {
  const filePath = safePath(summaryDir(memoryDir, userId), `${category}.md`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List all category slugs (filenames without .md extension).
 * Excludes files starting with underscore (e.g. _store.db).
 */
export async function listCategories(memoryDir: string): Promise<string[]> {
  try {
    const files = await readdir(memoryDir);
    return files
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/**
 * Check if a category summary file exists.
 */
export async function categoryExists(
  memoryDir: string,
  category: string,
): Promise<boolean> {
  const filePath = safePath(memoryDir, `${category}.md`);
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create empty summary files for all 10 default categories.
 * Skips any that already exist — safe to call repeatedly.
 */
export async function initDefaultCategories(memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  for (const cat of DEFAULT_CATEGORIES) {
    const exists = await categoryExists(memoryDir, cat);
    if (!exists) {
      await writeSummary(memoryDir, cat, `# ${cat}\n`);
    }
  }
}
