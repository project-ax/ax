import { describe, it, expect, vi } from 'vitest';
import { create } from '../../../src/providers/eventbus/inprocess.js';
import type { EventBusProvider, StreamEvent, EventListener } from '../../../src/providers/eventbus/types.js';
import type { Config } from '../../../src/types.js';

/** Minimal config stub — the in-process provider doesn't use config. */
const stubConfig = {} as Config;

function makeEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: 'test.event',
    requestId: 'req-1',
    timestamp: Date.now(),
    data: { foo: 'bar' },
    ...overrides,
  };
}

describe('EventBusProvider (inprocess)', () => {
  it('create() returns an EventBusProvider', () => {
    const bus = create(stubConfig);
    expect(bus).toBeDefined();
    expect(typeof bus.emit).toBe('function');
    expect(typeof bus.subscribe).toBe('function');
    expect(typeof bus.subscribeRequest).toBe('function');
    expect(typeof bus.listenerCount).toBe('function');
    expect(typeof bus.close).toBe('function');
  });

  it('emit delivers events to global subscribers', () => {
    const bus = create(stubConfig);
    const listener = vi.fn<EventListener>();
    bus.subscribe(listener);

    const event = makeEvent();
    bus.emit(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('subscribe returns an unsubscribe function', () => {
    const bus = create(stubConfig);
    const listener = vi.fn<EventListener>();
    const unsub = bus.subscribe(listener);

    bus.emit(makeEvent());
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    bus.emit(makeEvent());
    // Should not receive the second event
    expect(listener).toHaveBeenCalledOnce();
  });

  it('subscribeRequest only receives events for the matching requestId', () => {
    const bus = create(stubConfig);
    const listener = vi.fn<EventListener>();
    bus.subscribeRequest('req-A', listener);

    // Should NOT trigger — different requestId
    bus.emit(makeEvent({ requestId: 'req-B' }));
    expect(listener).not.toHaveBeenCalled();

    // SHOULD trigger — matching requestId
    const matchingEvent = makeEvent({ requestId: 'req-A' });
    bus.emit(matchingEvent);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(matchingEvent);
  });

  it('subscribeRequest returns an unsubscribe function', () => {
    const bus = create(stubConfig);
    const listener = vi.fn<EventListener>();
    const unsub = bus.subscribeRequest('req-X', listener);

    bus.emit(makeEvent({ requestId: 'req-X' }));
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    bus.emit(makeEvent({ requestId: 'req-X' }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('listenerCount reflects global subscriber count', () => {
    const bus = create(stubConfig);
    expect(bus.listenerCount()).toBe(0);

    const unsub1 = bus.subscribe(() => {});
    expect(bus.listenerCount()).toBe(1);

    const unsub2 = bus.subscribe(() => {});
    expect(bus.listenerCount()).toBe(2);

    unsub1();
    expect(bus.listenerCount()).toBe(1);

    unsub2();
    expect(bus.listenerCount()).toBe(0);
  });

  it('multiple global and request subscribers receive the same event', () => {
    const bus = create(stubConfig);
    const global1 = vi.fn<EventListener>();
    const global2 = vi.fn<EventListener>();
    const reqListener = vi.fn<EventListener>();

    bus.subscribe(global1);
    bus.subscribe(global2);
    bus.subscribeRequest('req-multi', reqListener);

    const event = makeEvent({ requestId: 'req-multi' });
    bus.emit(event);

    expect(global1).toHaveBeenCalledWith(event);
    expect(global2).toHaveBeenCalledWith(event);
    expect(reqListener).toHaveBeenCalledWith(event);
  });

  it('close() is a no-op and does not throw', () => {
    const bus = create(stubConfig);
    bus.subscribe(() => {});
    expect(() => bus.close()).not.toThrow();
  });

  it('listener errors do not propagate to emit()', () => {
    const bus = create(stubConfig);
    const goodListener = vi.fn<EventListener>();

    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe(goodListener);

    // Should not throw, and the good listener should still be called
    expect(() => bus.emit(makeEvent())).not.toThrow();
    expect(goodListener).toHaveBeenCalledOnce();
  });
});
