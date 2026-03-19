import { describe, it, expect } from 'vitest';
import { requestCredential } from '../../src/host/credential-prompts.js';
import { createEventBus } from '../../src/host/event-bus.js';

describe('requestCredential (event bus backed)', () => {
  it('resolves when credential.resolved event arrives with matching envName', async () => {
    const eventBus = createEventBus();
    const requestId = 'req-1';

    const promise = requestCredential('sess-1', 'MY_KEY', eventBus, requestId, 5000);

    // Simulate credential.resolved event (from POST /v1/credentials/provide)
    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId,
        timestamp: Date.now(),
        data: { envName: 'MY_KEY', sessionId: 'sess-1', value: 'the_secret' },
      });
    }, 50);

    const result = await promise;
    expect(result).toBe('the_secret');
  });

  it('ignores credential.resolved events for different envName', async () => {
    const eventBus = createEventBus();
    const requestId = 'req-2';

    const promise = requestCredential('sess-1', 'MY_KEY', eventBus, requestId, 500);

    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId,
        timestamp: Date.now(),
        data: { envName: 'OTHER_KEY', sessionId: 'sess-1', value: 'wrong' },
      });
    }, 50);

    const result = await promise;
    expect(result).toBeNull(); // timeout — wrong envName
  });

  it('returns null on timeout', async () => {
    const eventBus = createEventBus();
    const result = await requestCredential('sess-1', 'MY_KEY', eventBus, 'req-3', 100);
    expect(result).toBeNull();
  });

  it('unsubscribes from event bus after resolution', async () => {
    const eventBus = createEventBus();
    const requestId = 'req-4';

    const promise = requestCredential('sess-1', 'MY_KEY', eventBus, requestId, 5000);

    // Resolve it
    eventBus.emit({
      type: 'credential.resolved',
      requestId,
      timestamp: Date.now(),
      data: { envName: 'MY_KEY', sessionId: 'sess-1', value: 'val' },
    });

    await promise;
    // No way to directly check listener count per-request, but at least verify no error on subsequent emit
    eventBus.emit({
      type: 'credential.resolved',
      requestId,
      timestamp: Date.now(),
      data: { envName: 'MY_KEY', sessionId: 'sess-1', value: 'val2' },
    });
  });
});
