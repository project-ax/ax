// src/providers/eventbus/inprocess.ts — In-process EventBusProvider
//
// Wraps the existing createEventBus() function behind the provider interface.
// close() is a no-op — the in-process event bus has no external resources.

import type { Config } from '../../types.js';
import type { EventBusProvider } from './types.js';
import { createEventBus } from '../../host/event-bus.js';

/**
 * Create an in-process EventBusProvider.
 *
 * Follows the standard provider contract: export a `create(config)` function.
 */
export function create(_config: Config): EventBusProvider {
  const bus = createEventBus();

  return {
    emit: bus.emit,
    subscribe: bus.subscribe,
    subscribeRequest: bus.subscribeRequest,
    listenerCount: bus.listenerCount,
    close(): void {
      // No-op for in-process: no external resources to release.
      // Listeners are garbage-collected when the bus goes out of scope.
    },
  };
}
