import { describe, test, expect } from 'vitest';
import { createEventBus } from '../../src/host/event-bus.js';

describe('credential provide endpoint', () => {
  test('resolveCredential is called with correct args', async () => {
    const { requestCredential } = await import('../../src/host/credential-prompts.js');
    const eventBus = createEventBus();

    // Start a pending request using event bus
    const promise = requestCredential('sess-1', 'LINEAR_API_KEY', eventBus, 'req-1', 5000);

    // Simulate the HTTP endpoint emitting credential.resolved via event bus
    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId: 'req-1',
        timestamp: Date.now(),
        data: { envName: 'LINEAR_API_KEY', sessionId: 'sess-1', value: 'lin_key_123' },
      });
    }, 10);

    const result = await promise;
    expect(result).toBe('lin_key_123');
  });
});
