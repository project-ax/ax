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

  it('returns AI SDK format content blocks when response includes images', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const sessionId = randomUUID();
    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'generate an image of a cow' }],
        session_id: sessionId,
      },
    });

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);

    // Content should be an array of AI SDK content parts
    const content = data.choices[0].message.content;
    expect(Array.isArray(content)).toBe(true);
    // Text block stays as { type: 'text', text: '...' }
    const textBlock = content.find((b: any) => b.type === 'text');
    expect(textBlock).toBeDefined();
    // Image block uses AI SDK file format: { type: 'file', url, mediaType }
    const fileBlock = content.find((b: any) => b.type === 'file');
    expect(fileBlock).toBeDefined();
    expect(fileBlock.url).toBe('/ax/generated-abc123.png');
    expect(fileBlock.mediaType).toBe('image/png');
  });

  it('returns plain string content when no image blocks are present', async () => {
    // Override mock for this test — text-only response
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

    // Content should remain a plain string when no images are present
    expect(typeof data.choices[0].message.content).toBe('string');
    expect(data.choices[0].message.content).toBe('Just a text reply.');
  });

  it('returns multiple file blocks in AI SDK format', async () => {
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
    const content = data.choices[0].message.content;
    expect(Array.isArray(content)).toBe(true);
    const fileBlocks = content.filter((b: any) => b.type === 'file');
    expect(fileBlocks).toHaveLength(2);
    expect(fileBlocks[0].url).toBe('/ax/first.png');
    expect(fileBlocks[0].mediaType).toBe('image/png');
    expect(fileBlocks[1].url).toBe('/ax/second.jpg');
    expect(fileBlocks[1].mediaType).toBe('image/jpeg');
  });
});
