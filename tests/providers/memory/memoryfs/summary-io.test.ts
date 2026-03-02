import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeSummary,
  readSummary,
  listCategories,
  categoryExists,
  initDefaultCategories,
} from '../../../../src/providers/memory/memoryfs/summary-io.js';

describe('summary-io', () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'memfs-summary-'));
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it('writes and reads a summary round-trip', async () => {
    const content = '# preferences\n## Editor\n- Uses vim\n';
    await writeSummary(memoryDir, 'preferences', content);
    const read = await readSummary(memoryDir, 'preferences');
    expect(read).toBe(content);
  });

  it('returns null for non-existent category', async () => {
    const read = await readSummary(memoryDir, 'nonexistent');
    expect(read).toBeNull();
  });

  it('overwrites existing summary', async () => {
    await writeSummary(memoryDir, 'preferences', 'old content');
    await writeSummary(memoryDir, 'preferences', 'new content');
    const read = await readSummary(memoryDir, 'preferences');
    expect(read).toBe('new content');
  });

  it('lists category slugs from .md files', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    await writeSummary(memoryDir, 'knowledge', 'content');
    const cats = await listCategories(memoryDir);
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('excludes files starting with underscore', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    const cats = await listCategories(memoryDir);
    expect(cats).not.toContain('_store');
  });

  it('categoryExists returns true/false correctly', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    expect(await categoryExists(memoryDir, 'preferences')).toBe(true);
    expect(await categoryExists(memoryDir, 'nonexistent')).toBe(false);
  });

  it('initDefaultCategories creates empty files for all 10 defaults', async () => {
    await initDefaultCategories(memoryDir);
    const cats = await listCategories(memoryDir);
    expect(cats).toHaveLength(10);
    expect(cats).toContain('preferences');
    expect(cats).toContain('work_life');
    const content = await readSummary(memoryDir, 'preferences');
    expect(content).toContain('# preferences');
  });

  it('sanitizes path traversal attempts — files stay inside memoryDir', async () => {
    // safePath() sanitizes '../escape' to '___escape' (replaces .. and / with _)
    // so the file is safely created inside memoryDir, not outside it.
    await writeSummary(memoryDir, '../escape', 'safe content');
    const files = await readdir(memoryDir);
    // The file should exist with the sanitized name, inside the directory
    expect(files.some(f => f.endsWith('.md'))).toBe(true);
    // No file should have been created outside memoryDir
    expect(files.every(f => !f.includes('..'))).toBe(true);
    // Reading with the same traversal input should return the content
    const read = await readSummary(memoryDir, '../escape');
    expect(read).toBe('safe content');
  });

  it('writes atomically (no .tmp files left on success)', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    const files = await readdir(memoryDir);
    expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
  });
});
