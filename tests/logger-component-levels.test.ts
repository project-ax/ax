// Per-component log level overrides via LOG_LEVEL_<COMPONENT> env vars.
//
// An operator working a single noisy subsystem (say, the k8s sandbox) should
// be able to crank that one up to debug without drowning the rest of the host
// in stack traces. The convention: take the component name, uppercase it,
// replace `-` with `_`, prefix with `LOG_LEVEL_`. So `sandbox-k8s` →
// `LOG_LEVEL_SANDBOX_K8S`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';

describe('per-component log levels', () => {
  // Save + restore env so tests don't bleed.
  const saved: Record<string, string | undefined> = {};
  const stash = (key: string) => { saved[key] = process.env[key]; };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  beforeEach(() => {
    stash('LOG_LEVEL');
    stash('LOG_LEVEL_SANDBOX_K8S');
    stash('LOG_LEVEL_HOST');
    stash('LOG_LEVEL_FOO_BAR');
  });

  afterEach(() => {
    restore();
  });

  it('LOG_LEVEL_SANDBOX_K8S=debug raises sandbox-k8s component level above default', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'sandbox-k8s', stream });
    log.debug('debug_should_appear');
    log.info('info_should_appear');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).msg).toBe('debug_should_appear');
  });

  it('default LOG_LEVEL applies when no component override is set', async () => {
    process.env.LOG_LEVEL = 'warn';
    delete process.env.LOG_LEVEL_HOST;
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'host', stream });
    log.info('info_should_be_filtered');
    log.warn('warn_should_appear');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('warn_should_appear');
  });

  it('component name with hyphens maps to env var with underscores', async () => {
    process.env.LOG_LEVEL = 'error';
    process.env.LOG_LEVEL_FOO_BAR = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'foo-bar', stream });
    log.debug('component_hyphen_to_underscore');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('component_hyphen_to_underscore');
  });

  it('explicit level option wins over env var (caller intent beats env)', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'sandbox-k8s', level: 'error', stream });
    log.warn('warn_should_be_filtered');
    log.error('error_should_appear');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('error_should_appear');
  });

  it('child() with a component binding picks up the env override', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const root = createLogger({ stream });
    const child = root.child({ component: 'sandbox-k8s' });
    child.debug('child_debug_via_component_env');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('child_debug_via_component_env');
  });
});
