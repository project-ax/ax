/**
 * Credential prompt coordination via event bus.
 *
 * requestCredential() subscribes to the event bus for credential.resolved
 * events and returns a Promise that resolves with the credential value.
 * Works across stateless host replicas: in-process event bus for local/Docker,
 * NATS-backed event bus for k8s.
 *
 * Replaces the old in-memory promise map pattern that required session affinity.
 */

import type { EventBus } from './event-bus.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'credential-prompts' });

/** How long to wait for the user to provide a credential before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Wait for a credential to be provided via the event bus.
 *
 * Subscribes to events for the given requestId and resolves when a
 * credential.resolved event with matching envName arrives. Returns the
 * credential value, or null on timeout.
 */
export function requestCredential(
  sessionId: string,
  envName: string,
  eventBus: EventBus,
  requestId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;

    const unsubscribe = eventBus.subscribeRequest(requestId, (event) => {
      if (settled) return;
      if (event.type !== 'credential.resolved') return;
      if (event.data?.envName !== envName) return;

      settled = true;
      clearTimeout(timer);
      unsubscribe();
      logger.info('credential_resolved_via_event', { sessionId, envName, requestId });
      resolve((event.data.value as string) ?? null);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      logger.info('credential_prompt_timeout', { sessionId, envName, requestId });
      resolve(null);
    }, timeoutMs);

    // Don't prevent process exit
    if (timer.unref) timer.unref();

    logger.debug('credential_prompt_waiting', { sessionId, envName, requestId });
  });
}
