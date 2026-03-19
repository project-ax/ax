import { describe, it, expect, vi } from 'vitest';
import { createSkillsHandlers } from '../../src/host/ipc-handlers/skills.js';
import { requestCredential } from '../../src/host/credential-prompts.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { IPCContext } from '../../src/host/ipc-server.js';

function stubProviders() {
  const stored = new Map<string, string>();
  return {
    credentials: {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => { stored.set(key, val); }),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}), query: vi.fn(async () => []) },
  } as any;
}

describe('credential_request end-to-end via event bus', () => {
  it('IPC handler records request, event bus resolves credential', async () => {
    const eventBus = createEventBus();
    const requestedCredentials = new Map<string, Set<string>>();
    const providers = stubProviders();

    const handlers = createSkillsHandlers(providers, { requestedCredentials });
    const ctx: IPCContext = { sessionId: 'sess-1', agentId: 'agent-1', requestId: 'req-1' };

    // Agent calls credential_request
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);

    // Verify it was recorded
    expect(requestedCredentials.get('sess-1')?.has('LINEAR_API_KEY')).toBe(true);

    // Simulate the host-side credential collection via event bus
    const credPromise = requestCredential('sess-1', 'LINEAR_API_KEY', eventBus, 'req-1', 5000);

    // Simulate frontend providing credential (POST /v1/credentials/provide)
    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId: 'req-1',
        timestamp: Date.now(),
        data: { envName: 'LINEAR_API_KEY', sessionId: 'sess-1', value: 'lin_test_abc' },
      });
    }, 50);

    const credValue = await credPromise;
    expect(credValue).toBe('lin_test_abc');
  });
});
