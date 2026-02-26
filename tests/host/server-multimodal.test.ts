import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

// Mock processCompletion before importing server
vi.mock('../../src/host/server-completions.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/host/server-completions.js')>();
  return {
    ...mod,
    processCompletion: vi.fn().mockResolvedValue({
      responseContent: 'Here is the image:\n\n![A cow sailing](generated-abc123.png)\n\nEnjoy!',
      contentBlocks: [
        { type: 'text', text: 'Here is the image:\n\n![A cow sailing](generated-abc123.png)\n\nEnjoy!' },
        { type: 'image', fileId: 'generated-abc123.png', mimeType: 'image/png' },
      ],
      agentName: 'main',
      userId: 'default',
      finishReason: 'stop',
    }),
  };
});

import { createServer, type AxServer } from '../../src/host/server.js';
import { loadConfig } from '../../src/config.js';
import { processCompletion } from '../../src/host/server-completions.js';

const mockedProcessCompletion = vi.mocked(processCompletion);

/** Send an HTTP request over a Unix socket */
function sendRequest(
  socket: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = httpRequest(
      {
        socketPath: socket,
        path,
        method: opts.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('Server multimodal responses', () => {
  let server: AxServer;
  let socketPath: string;
  let testAxHome: string;
  let originalAxHome: string | undefined;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-test-${randomUUID()}.sock`);
    testAxHome = join(tmpdir(), `ax-test-home-${randomUUID()}`);
    mkdirSync(testAxHome, { recursive: true });
    originalAxHome = process.env.AX_HOME;
    process.env.AX_HOME = testAxHome;
  });

  afterEach(async () => {
    if (server) await server.stop();
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
    rmSync(testAxHome, { recursive: true, force: true });
  });

  describe('non-streaming', () => {
    it('returns text content with files array when response includes images', async () => {
      const config = loadConfig('tests/integration/ax-test.yaml');
      server = await createServer(config, { socketPath });
      await server.start();

      const res = await sendRequest(socketPath, '/v1/chat/completions', {
        body: {
          messages: [{ role: 'user', content: 'generate an image of a cow' }],
          session_id: randomUUID(),
        },
      });

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);

      // Content stays as the text string
      expect(typeof data.choices[0].message.content).toBe('string');
      expect(data.choices[0].message.content).toContain('A cow sailing');

      // Files returned as a separate array on the message
      const { files } = data.choices[0].message;
      expect(files).toHaveLength(1);
      expect(files[0]).toEqual({ type: 'file', url: '/ax/generated-abc123.png', mediaType: 'image/png' });
    });

    it('returns plain string content with no files when text-only', async () => {
      mockedProcessCompletion.mockResolvedValueOnce({
        responseContent: 'Just a text reply.',
        contentBlocks: [
          { type: 'text', text: 'Just a text reply.' },
        ],
        finishReason: 'stop',
      });

      const config = loadConfig('tests/integration/ax-test.yaml');
      server = await createServer(config, { socketPath });
      await server.start();

      const res = await sendRequest(socketPath, '/v1/chat/completions', {
        body: { messages: [{ role: 'user', content: 'hello' }] },
      });

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);

      expect(typeof data.choices[0].message.content).toBe('string');
      expect(data.choices[0].message.content).toBe('Just a text reply.');
      expect(data.choices[0].message.files).toBeUndefined();
    });

    it('returns multiple files in files array', async () => {
      mockedProcessCompletion.mockResolvedValueOnce({
        responseContent: 'Two images:',
        contentBlocks: [
          { type: 'text', text: 'Two images:' },
          { type: 'image', fileId: 'first.png', mimeType: 'image/png' },
          { type: 'image', fileId: 'second.jpg', mimeType: 'image/jpeg' },
        ],
        agentName: 'main',
        userId: 'default',
        finishReason: 'stop',
      });

      const config = loadConfig('tests/integration/ax-test.yaml');
      server = await createServer(config, { socketPath });
      await server.start();

      const res = await sendRequest(socketPath, '/v1/chat/completions', {
        body: { messages: [{ role: 'user', content: 'generate images' }] },
      });

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);

      expect(typeof data.choices[0].message.content).toBe('string');
      const { files } = data.choices[0].message;
      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({ type: 'file', url: '/ax/first.png', mediaType: 'image/png' });
      expect(files[1]).toEqual({ type: 'file', url: '/ax/second.jpg', mediaType: 'image/jpeg' });
    });
  });

  describe('streaming', () => {
    it('streams text content and includes files on finish chunk', async () => {
      const config = loadConfig('tests/integration/ax-test.yaml');
      server = await createServer(config, { socketPath });
      await server.start();

      const res = await sendRequest(socketPath, '/v1/chat/completions', {
        body: {
          messages: [{ role: 'user', content: 'generate an image of a cow' }],
          session_id: randomUUID(),
          stream: true,
        },
      });

      expect(res.status).toBe(200);
      const lines = res.body.split('\n').filter((l: string) => l.startsWith('data: '));
      expect(lines.length).toBeGreaterThanOrEqual(4);

      // Content chunk is plain text, not a stringified array
      const contentChunk = JSON.parse(lines[1].replace('data: ', ''));
      expect(typeof contentChunk.choices[0].delta.content).toBe('string');
      expect(contentChunk.choices[0].delta.content).toContain('A cow sailing');
      expect(contentChunk.choices[0].delta.content).not.toContain('"type":"file"');

      // Finish chunk carries files
      const finishChunk = JSON.parse(lines[2].replace('data: ', ''));
      expect(finishChunk.choices[0].finish_reason).toBe('stop');
      expect(finishChunk.files).toHaveLength(1);
      expect(finishChunk.files[0]).toEqual({ type: 'file', url: '/ax/generated-abc123.png', mediaType: 'image/png' });
    });

    it('no files field on finish chunk for text-only responses', async () => {
      mockedProcessCompletion.mockResolvedValueOnce({
        responseContent: 'Just text.',
        contentBlocks: [{ type: 'text', text: 'Just text.' }],
        finishReason: 'stop',
      });

      const config = loadConfig('tests/integration/ax-test.yaml');
      server = await createServer(config, { socketPath });
      await server.start();

      const res = await sendRequest(socketPath, '/v1/chat/completions', {
        body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
      });

      expect(res.status).toBe(200);
      const lines = res.body.split('\n').filter((l: string) => l.startsWith('data: '));

      const contentChunk = JSON.parse(lines[1].replace('data: ', ''));
      expect(contentChunk.choices[0].delta.content).toBe('Just text.');

      const finishChunk = JSON.parse(lines[2].replace('data: ', ''));
      expect(finishChunk.files).toBeUndefined();
    });
  });
});
