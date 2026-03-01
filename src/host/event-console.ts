/**
 * Event Console — beautiful real-time event display for default verbosity.
 *
 * Subscribes to the EventBus and prints a compact, color-coded line per event.
 * Format:  HH:MM:SS  event.type  status
 *
 * Skips noisy events (llm.chunk) to keep output readable.
 */

import { styleText } from 'node:util';
import type { EventBus, StreamEvent } from './event-bus.js';

// ═══════════════════════════════════════════════════════
// Color helpers
// ═══════════════════════════════════════════════════════

const dim   = (s: string) => styleText('gray', s);
const green = (s: string) => styleText('green', s);
const yellow = (s: string) => styleText('yellow', s);
const red   = (s: string) => styleText('red', s);
const bold  = (s: string) => styleText('bold', s);

// ═══════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Derive a compact status string + color from event type and data. */
function formatEvent(event: StreamEvent): { label: string; status: string } | null {
  const { type, data } = event;

  switch (type) {
    case 'completion.start':
      return { label: 'completion.start', status: green('ok') };

    case 'completion.agent':
      return { label: `agent: ${data.agentType}`, status: green('spawn') };

    case 'completion.done':
      return { label: 'completion.done', status: green('ok') };

    case 'completion.error':
      return { label: 'completion.error', status: red(String(data.error ?? 'unknown')) };

    case 'llm.start':
      return { label: 'llm.start', status: green('ok') };

    case 'llm.thinking':
      return { label: 'llm.thinking', status: green('stream') };

    case 'llm.done': {
      const parts: string[] = [];
      if (data.inputTokens != null) parts.push(`in:${data.inputTokens}`);
      if (data.outputTokens != null) parts.push(`out:${data.outputTokens}`);
      if (data.toolUseCount) parts.push(`tools:${data.toolUseCount}`);
      return { label: 'llm.done', status: dim(parts.join(' ') || 'ok') };
    }

    case 'tool.call': {
      const name = data.toolName ?? 'unknown';
      const extra = name === 'agent' ? ` wait=${data.wait ?? 'undefined'}` : '';
      return { label: `tool.call: ${name}`, status: green('ok') + dim(extra) };
    }

    case 'scan.inbound': {
      const verdict = data.verdict as string;
      if (verdict === 'BLOCK') {
        return { label: 'scan.inbound', status: red('blocked') };
      }
      return { label: 'scan.inbound', status: green('ok') };
    }

    case 'scan.outbound': {
      if (data.canaryLeaked) {
        return { label: 'scan.outbound', status: red('canary leaked') };
      }
      const verdict = data.verdict as string | undefined;
      if (verdict === 'BLOCK') {
        return { label: 'scan.outbound', status: red('blocked') };
      }
      if (verdict === 'FLAG') {
        return { label: 'scan.outbound', status: yellow('flagged') };
      }
      return { label: 'scan.outbound', status: green('ok') };
    }

    case 'server.config':
      return { label: 'server.config', status: dim(`profile: ${data.profile}`) };

    case 'server.providers':
      return { label: 'server.providers', status: green('ok') };

    case 'server.ready': {
      const parts: string[] = [];
      if (data.socket) parts.push(String(data.socket));
      if (data.port) parts.push(`port: ${data.port}`);
      return { label: 'server.ready', status: green(parts.join('  ')) };
    }

    // Skip noisy per-chunk events
    case 'llm.chunk':
      return null;

    default:
      return { label: type, status: dim('event') };
  }
}

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

/**
 * Attach a console subscriber to the event bus that prints
 * compact, color-coded event lines to stdout.
 *
 * Returns an unsubscribe function.
 */
export function attachEventConsole(eventBus: EventBus): () => void {
  return eventBus.subscribe((event) => {
    const formatted = formatEvent(event);
    if (!formatted) return;

    const time = dim(formatTime(event.timestamp));
    const label = bold(formatted.label);
    process.stdout.write(`${time}  ${label}  ${formatted.status}\n`);
  });
}

/**
 * Attach a JSON subscriber that writes each event as a single JSONL line.
 * Used in --json mode and non-TTY (piped) output.
 */
export function attachJsonEventConsole(eventBus: EventBus): () => void {
  return eventBus.subscribe((event) => {
    // Skip noisy per-chunk events even in JSON mode
    if (event.type === 'llm.chunk') return;
    process.stdout.write(JSON.stringify(event) + '\n');
  });
}
