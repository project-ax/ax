/**
 * Integration test for the OpenAI-compatible LLM provider.
 *
 * Spins up a mock HTTP server that returns OpenAI-format SSE responses,
 * then exercises the full streaming flow through the provider.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { create } from '../../../src/providers/llm/openai.js';
import type { Config } from '../../../src/types.js';
import type { ChatChunk } from '../../../src/providers/llm/types.js';

const config = {} as Config;

// ───────────────────────────────────────────────────────
// Mock server helpers
// ───────────────────────────────────────────────────────

/** Start a mock HTTP server on the given port.
 *  The handler receives the parsed request body and writes the response. */
function startMockServer(
  port: number,
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      handler(req, Buffer.concat(chunks).toString(), res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Write SSE lines to a response and close it. */
function writeSSE(res: ServerResponse, events: string[]): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of events) {
    res.write(`data: ${event}\n\n`);
  }
  res.end();
}

/** Build SSE events for a simple text streaming response. */
function buildTextSSE(text: string): string[] {
  return [
    // First chunk: role only
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }),
    // Content chunk
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }),
    // Final chunk with finish_reason and usage
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    '[DONE]',
  ];
}

/** Build SSE events for a tool call streaming response. */
function buildToolCallSSE(): string[] {
  return [
    // First chunk: tool call start (id + function name)
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_abc',
            type: 'function',
            function: { name: 'read_file', arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    }),
    // Second chunk: argument fragment
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"path":"/tmp/test.txt"}' },
          }],
        },
        finish_reason: null,
      }],
    }),
    // Final chunk with finish_reason and usage
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
    }),
    '[DONE]',
  ];
}

// ───────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────

describe('openai provider integration', () => {
  const PORT = 18923;
  let server: HttpServer | undefined;

  const envVarsToSave = ['GROQ_API_KEY', 'GROQ_BASE_URL'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envVarsToSave) {
      saved[key] = process.env[key];
    }
    // Point the provider at our mock server
    process.env.GROQ_API_KEY = 'test-key';
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
  });

  afterEach(async () => {
    // Restore env
    for (const key of envVarsToSave) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    // Tear down mock server
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  test('streams text response from mock server', async () => {
    server = await startMockServer(PORT, (_req, _body, res) => {
      writeSSE(res, buildTextSSE('Hello from mock!'));
    });

    const provider = await create(config, 'groq');
    const chunks: ChatChunk[] = [];

    for await (const chunk of provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    // Should have a text chunk
    const textChunks = chunks.filter(c => c.type === 'text');
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(textChunks.map(c => c.content).join('')).toBe('Hello from mock!');

    // Should have a done chunk with usage
    const doneChunk = chunks.find(c => c.type === 'done');
    expect(doneChunk).toBeDefined();
    expect(doneChunk!.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test('sends tool_choice auto when tools are provided', async () => {
    let capturedBody = '';
    server = await startMockServer(PORT, (_req, body, res) => {
      capturedBody = body;
      writeSSE(res, buildTextSSE('ok'));
    });

    const provider = await create(config, 'groq');

    // With tools — should include tool_choice
    for await (const _chunk of provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    })) { /* drain */ }

    const parsed = JSON.parse(capturedBody);
    expect(parsed.tool_choice).toBe('auto');
    expect(parsed.tools).toBeDefined();
    expect(parsed.tools).toHaveLength(1);

    // Without tools — should NOT include tool_choice
    capturedBody = '';
    for await (const _chunk of provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hi' }],
    })) { /* drain */ }

    const parsedNoTools = JSON.parse(capturedBody);
    expect(parsedNoTools.tool_choice).toBeUndefined();
    expect(parsedNoTools.tools).toBeUndefined();
  });

  test('streams tool call response from mock server', async () => {
    server = await startMockServer(PORT, (_req, _body, res) => {
      writeSSE(res, buildToolCallSSE());
    });

    const provider = await create(config, 'groq');
    const chunks: ChatChunk[] = [];

    for await (const chunk of provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Read the file /tmp/test.txt' }],
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
    })) {
      chunks.push(chunk);
    }

    // Should have a tool_use chunk
    const toolChunks = chunks.filter(c => c.type === 'tool_use');
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].toolCall).toEqual({
      id: 'call_abc',
      name: 'read_file',
      args: { path: '/tmp/test.txt' },
    });

    // Should have a done chunk with usage
    const doneChunk = chunks.find(c => c.type === 'done');
    expect(doneChunk).toBeDefined();
    expect(doneChunk!.usage).toEqual({ inputTokens: 15, outputTokens: 10 });
  });

  test('yields tool calls with non-standard finish_reason (e.g. Gemini STOP)', async () => {
    // Gemini via OpenRouter may use "STOP" instead of "tool_calls"
    const sseChunks = [
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_gem1',
              type: 'function',
              function: { name: 'identity', arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      }),
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"file":"SOUL.md","content":"# Soul"}' },
            }],
          },
          finish_reason: null,
        }],
      }),
      // Non-standard finish_reason from Gemini
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'STOP' }],
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
      }),
      '[DONE]',
    ];

    server = await startMockServer(PORT, (_req, _body, res) => {
      writeSSE(res, sseChunks);
    });

    const provider = await create(config, 'groq');
    const chunks: ChatChunk[] = [];

    for await (const chunk of provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Set up identity' }],
      tools: [{
        name: 'identity',
        description: 'Write identity file',
        parameters: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } } },
      }],
    })) {
      chunks.push(chunk);
    }

    // Tool call must be yielded despite non-standard finish_reason
    const toolChunks = chunks.filter(c => c.type === 'tool_use');
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].toolCall).toEqual({
      id: 'call_gem1',
      name: 'identity',
      args: { file: 'SOUL.md', content: '# Soul' },
    });
  });
});
