import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';

// We'll test via createLogger which returns our Logger interface

describe('Logger', () => {
  let lines: string[];
  let testStream: Writable;

  beforeEach(() => {
    lines = [];
    testStream = new Writable({
      write(chunk, _enc, cb) {
        // pino writes JSON lines
        const text = chunk.toString().trim();
        if (text) lines.push(text);
        cb();
      },
    });
  });

  it('should log info with message and details', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.info('agent_spawn', { sandbox: 'bwrap' });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(30); // pino info level
    expect(entry.msg).toBe('agent_spawn');
    expect(entry.sandbox).toBe('bwrap');
  });

  it('should log warn level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.warn('rate_limited', { status: 429 });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(40); // pino warn level
    expect(entry.msg).toBe('rate_limited');
  });

  it('should log error level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.error('agent_failed', { exitCode: 1 });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(50);
    expect(entry.msg).toBe('agent_failed');
  });

  it('should log debug level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.debug('ipc_call', { action: 'llm_call' });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(20);
  });

  it('should filter by log level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'warn' });
    logger.debug('should_not_appear');
    logger.info('should_not_appear');
    logger.warn('should_appear');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('should_appear');
  });

  it('should create child logger with bound context', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    const child = logger.child({ reqId: 'abc123', component: 'server' });
    child.info('request_start');

    const entry = JSON.parse(lines[0]);
    expect(entry.reqId).toBe('abc123');
    expect(entry.component).toBe('server');
    expect(entry.msg).toBe('request_start');
  });

  it('should nest child logger context', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    const child1 = logger.child({ reqId: 'abc123' });
    const child2 = child1.child({ step: 'proxy' });
    child2.info('call');

    const entry = JSON.parse(lines[0]);
    expect(entry.reqId).toBe('abc123');
    expect(entry.step).toBe('proxy');
  });

  it('should include pid and timestamp', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.info('test');

    const entry = JSON.parse(lines[0]);
    expect(entry.pid).toBe(process.pid);
    expect(entry.time).toBeDefined();
  });
});

/** Strip ANSI escape codes for assertion readability. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('prettyFormat', () => {
  it('formats info without level label suffix', async () => {
    const { prettyFormat } = await import('../src/logger.js');
    const output = stripAnsi(prettyFormat({
      time: 1709128837000,
      level: 30,
      msg: 'server_ready',
      port: 8080,
    }));
    expect(output).toContain('server_ready');
    expect(output).toContain('port=8080');
    // Info should NOT have a level suffix like "info"
    expect(output).not.toMatch(/\binfo\b/);
    expect(output).toMatch(/\n$/);
  });

  it('formats warn without level label suffix (color is enough)', async () => {
    const { prettyFormat } = await import('../src/logger.js');
    const output = stripAnsi(prettyFormat({
      time: 1709128837000,
      level: 40,
      msg: 'browser_disabled',
      hint: 'npx playwright install chromium',
    }));
    expect(output).toContain('browser_disabled');
    expect(output).toContain('hint=npx playwright install chromium');
    expect(output).not.toMatch(/\bwarn\b/);
  });

  it('formats error without level label suffix (color is enough)', async () => {
    const { prettyFormat } = await import('../src/logger.js');
    const output = stripAnsi(prettyFormat({
      time: 1709128837000,
      level: 50,
      msg: 'agent_failed',
      exitCode: 1,
    }));
    expect(output).toContain('agent_failed');
    expect(output).not.toMatch(/\berror\b/);
  });

  it('includes timestamp in HH:MM:SS format', async () => {
    const { prettyFormat } = await import('../src/logger.js');
    const output = stripAnsi(prettyFormat({
      time: 1709128837000,
      level: 30,
      msg: 'test',
    }));
    expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
