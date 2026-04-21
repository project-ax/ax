import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig, DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES } from '../src/config.js';

/**
 * Helper to write a temp config, run a test, and clean up.
 * Mirrors the pattern in tests/config.test.ts.
 */
async function withTempConfig(yaml: string, fn: (path: string) => void): Promise<void> {
  const { writeFileSync, rmSync } = await import('node:fs');
  const tmpPath = resolve(import.meta.dirname, `../ax-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(tmpPath, yaml);
  try {
    fn(tmpPath);
  } finally {
    rmSync(tmpPath);
  }
}

describe('Config: tool_dispatch', () => {
  test('defaults tool_dispatch.mode to indirect', async () => {
    await withTempConfig(`profile: balanced\n`, (tmpPath) => {
      const cfg = loadConfig(tmpPath);
      expect(cfg.tool_dispatch).toBeDefined();
      expect(cfg.tool_dispatch.mode).toBe('indirect');
    });
  });

  test('defaults spill_threshold_bytes to 20480', async () => {
    await withTempConfig(`profile: balanced\n`, (tmpPath) => {
      const cfg = loadConfig(tmpPath);
      expect(cfg.tool_dispatch.spill_threshold_bytes).toBe(DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES);
      expect(cfg.tool_dispatch.spill_threshold_bytes).toBe(20480);
    });
  });

  test('accepts mode: direct', async () => {
    await withTempConfig(`
profile: balanced
tool_dispatch:
  mode: direct
`, (tmpPath) => {
      const cfg = loadConfig(tmpPath);
      expect(cfg.tool_dispatch.mode).toBe('direct');
    });
  });

  test('accepts mode: indirect explicitly', async () => {
    await withTempConfig(`
profile: balanced
tool_dispatch:
  mode: indirect
`, (tmpPath) => {
      const cfg = loadConfig(tmpPath);
      expect(cfg.tool_dispatch.mode).toBe('indirect');
    });
  });

  test('accepts custom spill_threshold_bytes', async () => {
    await withTempConfig(`
profile: balanced
tool_dispatch:
  mode: indirect
  spill_threshold_bytes: 65536
`, (tmpPath) => {
      const cfg = loadConfig(tmpPath);
      expect(cfg.tool_dispatch.spill_threshold_bytes).toBe(65536);
    });
  });

  test('rejects unknown modes', async () => {
    await withTempConfig(`
profile: balanced
tool_dispatch:
  mode: bogus
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow(/tool_dispatch\.mode/);
    });
  });

  test('rejects unknown keys (strict mode)', async () => {
    await withTempConfig(`
profile: balanced
tool_dispatch:
  mode: indirect
  unknown_field: true
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow(/unknown_field/);
    });
  });

  test('rejects non-positive spill_threshold_bytes', async () => {
    await withTempConfig(`
profile: balanced
tool_dispatch:
  mode: indirect
  spill_threshold_bytes: 0
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow();
    });
  });
});
