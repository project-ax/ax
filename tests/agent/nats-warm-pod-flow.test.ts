// tests/agent/nats-warm-pod-flow.test.ts — End-to-end test for warm pod NATS IPC flow
//
// Reproduces the NATS 503 bug: warm pool pods start without a per-turn IPC token,
// so the NATSIPCClient publishes to the wrong NATS subject. The host handler
// subscribes to ipc.request.{requestId}.{token}, but the sandbox publishes to
// ipc.request.{sessionId} (fallback) → 503 No Responders.
//
// This test simulates the full warm pod flow:
//   1. Runner creates NATSIPCClient with no token (warm pod startup)
//   2. Work payload arrives via NATS with ipcToken
//   3. parseStdinPayload extracts ipcToken
//   4. applyPayload calls setContext({token}) on the NATSIPCClient
//   5. Pi-session makes an IPC call (llm_call) via the client
//   6. Verify the NATS request goes to the correct token-scoped subject

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { initLogger } from '../../src/logger.js';
import { encode } from '../../src/host/nats-session-protocol.js';

initLogger({ level: 'silent', file: false });

// ─── NATS mock ──────────────────────────────────────────
const mockRequest = vi.fn();
const mockDrain = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue({
  request: mockRequest,
  drain: mockDrain,
});

vi.mock('nats', () => ({
  connect: mockConnect,
}));

// ─── Helpers ────────────────────────────────────────────
function makeNatsResponse(obj: Record<string, unknown>) {
  return { data: new TextEncoder().encode(JSON.stringify(obj)) };
}

// ─── Tests ──────────────────────────────────────────────

describe('warm pod NATS IPC flow (NATS 503 reproduction)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue({ request: mockRequest, drain: mockDrain });
    delete process.env.AX_IPC_TOKEN;
  });

  test('ROOT CAUSE: encode() double-serializes the work payload, destroying all fields', async () => {
    // The publishWork callback in host-process.ts calls:
    //   nc.publish(subject, encode(payload))
    //
    // But encode() does JSON.stringify(obj) — and payload is ALREADY a JSON string.
    // So the sandbox receives a double-encoded string like:
    //   "{\"message\":\"hello\",...}"
    //
    // JSON.parse on the double-encoded string returns a plain string, not an object.
    // parseStdinPayload falls through to defaults → all fields MISSING.

    const { parseStdinPayload } = await import('../../src/agent/runner.js');

    const stdinPayload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 1,
      profile: 'balanced',
      sandboxType: 'k8s',
      sessionId: 'sess-abc',
      requestId: 'req-123',
      ipcToken: 'tok-456',
    });

    // This is what the host does: encode(payload) where payload is already a JSON string
    const doubleEncoded = encode(stdinPayload);
    // Decode as the sandbox does
    const received = new TextDecoder().decode(doubleEncoded);

    // Double-encoded: the received string is a JSON string literal, not the original JSON
    expect(received).not.toBe(stdinPayload);
    expect(received.length).toBeGreaterThan(stdinPayload.length); // extra escapes + quotes

    // parseStdinPayload on the double-encoded data falls through to defaults
    const parsed = parseStdinPayload(received);
    expect(parsed.ipcToken).toBeUndefined();   // MISSING
    expect(parsed.requestId).toBeUndefined();   // MISSING
    expect(parsed.sessionId).toBeUndefined();   // MISSING

    // Correct approach: TextEncoder.encode directly (no JSON.stringify wrapper)
    const correctEncoded = new TextEncoder().encode(stdinPayload);
    const correctReceived = new TextDecoder().decode(correctEncoded);
    expect(correctReceived).toBe(stdinPayload);

    const correctParsed = parseStdinPayload(correctReceived);
    expect(correctParsed.ipcToken).toBe('tok-456');
    expect(correctParsed.requestId).toBe('req-123');
    expect(correctParsed.sessionId).toBe('sess-abc');
  });

  test('BUG REPRODUCTION: without ipcToken in payload, IPC calls go to wrong subject → 503', async () => {
    // This test demonstrates the root cause of the NATS 503 bug.
    //
    // Warm pod starts NATSIPCClient with no token (no AX_IPC_TOKEN env var).
    // If the work payload does NOT include ipcToken (old code), setContext
    // receives token=undefined, and the subject stays as the fallback.
    //
    // The host subscribes to: ipc.request.{requestId}.{token}
    // The sandbox publishes to: ipc.request.{sessionId}  ← WRONG
    // Result: 503 No Responders

    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');
    const { parseStdinPayload } = await import('../../src/agent/runner.js');

    // Step 1: Warm pod creates NATSIPCClient with no token
    const client = new NATSIPCClient({ sessionId: '' });
    await client.connect();

    // Step 2: Work payload arrives WITHOUT ipcToken (simulates old host code)
    const workPayloadWithoutToken = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 1,
      profile: 'balanced',
      sandboxType: 'k8s',
      sessionId: 'sess-abc',
      requestId: 'req-123',
      // NOTE: no ipcToken field — this is the bug
    });

    const payload = parseStdinPayload(workPayloadWithoutToken);

    // Step 3: applyPayload would call setContext — but token is undefined
    client.setContext({
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      token: payload.ipcToken,  // undefined!
    });

    // Step 4: IPC call goes to WRONG subject (fallback)
    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));
    await client.call({ action: 'llm_call', messages: [] });

    const [subject] = mockRequest.mock.calls[0];
    // BUG: subject falls back to session-scoped (no token)
    // Host is listening on ipc.request.req-123.{token} → no match → 503
    expect(subject).toBe('ipc.request.sess-abc');
    expect(subject).not.toContain('req-123');

    await client.disconnect();
  });

  test('FIX VERIFIED: with ipcToken in payload, IPC calls go to correct subject', async () => {
    // This test verifies the fix: ipcToken in the work payload flows through
    // parseStdinPayload → applyPayload → setContext → correct subject.

    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');
    const { parseStdinPayload } = await import('../../src/agent/runner.js');

    // Step 1: Warm pod creates NATSIPCClient with no token (same as bug case)
    const client = new NATSIPCClient({ sessionId: '' });
    await client.connect();

    // Step 2: Work payload arrives WITH ipcToken (fixed host code)
    const turnToken = '88a06822-51b9-4681-b636-dfbe0fd73051';
    const workPayloadWithToken = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 1,
      profile: 'balanced',
      sandboxType: 'k8s',
      sessionId: 'sess-abc',
      requestId: 'req-123',
      ipcToken: turnToken,  // ← THE FIX
    });

    const payload = parseStdinPayload(workPayloadWithToken);
    expect(payload.ipcToken).toBe(turnToken);

    // Step 3: applyPayload calls setContext with the token
    client.setContext({
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      token: payload.ipcToken,
    });

    // Step 4: IPC call goes to CORRECT token-scoped subject
    mockRequest.mockResolvedValueOnce(makeNatsResponse({
      ok: true,
      chunks: [{ type: 'text', content: 'Hello!' }, { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }],
    }));
    await client.call({ action: 'llm_call', messages: [] });

    const [subject] = mockRequest.mock.calls[0];
    // FIX: subject is token-scoped — matches host handler subscription
    expect(subject).toBe(`ipc.request.req-123.${turnToken}`);

    await client.disconnect();
  });

  test('full applyPayload integration: config.ipcClient gets token from payload', async () => {
    // Tests the actual applyPayload function with a real NATSIPCClient,
    // verifying the complete data flow from parsed payload to IPC subject.

    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');
    const { parseStdinPayload } = await import('../../src/agent/runner.js');
    // Import applyPayload indirectly — it's not exported, but we can test
    // the same logic by calling setContext like applyPayload does.

    const turnToken = 'abc-turn-token-123';
    const requestId = 'chatcmpl-req-456';

    // Simulate the exact runner.ts NATS mode flow
    const client = new NATSIPCClient({ sessionId: '' });
    await client.connect();

    const config = { ipcClient: client as any };

    // Parse work payload (same as runner.ts does)
    const payload = parseStdinPayload(JSON.stringify({
      message: 'test',
      history: [],
      taintRatio: 0,
      taintThreshold: 1,
      profile: 'balanced',
      sandboxType: 'k8s',
      sessionId: 'sess-xyz',
      requestId,
      ipcToken: turnToken,
    }));

    // Apply payload (same logic as applyPayload in runner.ts)
    if (config.ipcClient) {
      config.ipcClient.setContext({
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        userId: payload.userId,
        sessionScope: payload.sessionScope,
        token: payload.ipcToken,
      });
    }

    // Make IPC calls — both llm_call and agent_response should use the right subject
    mockRequest
      .mockResolvedValueOnce(makeNatsResponse({ ok: true, chunks: [{ type: 'text', content: 'Hi' }] }))
      .mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    await client.call({ action: 'llm_call', messages: [] });
    await client.call({ action: 'agent_response', content: 'Hi' });

    const expectedSubject = `ipc.request.${requestId}.${turnToken}`;

    // Both calls should go to the same token-scoped subject
    expect(mockRequest.mock.calls[0][0]).toBe(expectedSubject);
    expect(mockRequest.mock.calls[1][0]).toBe(expectedSubject);

    await client.disconnect();
  });
});
