/**
 * ScriptedLLM — a mock LLM provider that follows a pre-defined script.
 *
 * Each "turn" in the script defines what the LLM should yield when called.
 * Turns are consumed in order by default, or matched conditionally via a
 * predicate on the incoming messages.
 *
 * Supports:
 *  - Sequential turns (consumed in FIFO order)
 *  - Conditional turns (matched by message content)
 *  - Multi-chunk responses (text, tool_use, done)
 *  - Call recording for assertions
 */

import type { ChatRequest, ChatChunk, LLMProvider } from '../../src/providers/llm/types.js';

// ─── Turn Definition ─────────────────────────────────

export interface LLMTurn {
  /** Optional matcher — if provided, this turn fires when matcher returns true. */
  match?: (req: ChatRequest) => boolean;
  /** The chunks to yield for this turn. */
  chunks: ChatChunk[];
}

/** Convenience: create a text-only turn. */
export function textTurn(content: string, usage = { inputTokens: 10, outputTokens: 5 }): LLMTurn {
  return {
    chunks: [
      { type: 'text', content },
      { type: 'done', usage },
    ],
  };
}

/** Convenience: create a tool_use turn (LLM wants to call a tool). */
export function toolUseTurn(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { id?: string; usage?: { inputTokens: number; outputTokens: number } },
): LLMTurn {
  return {
    chunks: [
      {
        type: 'tool_use',
        toolCall: {
          id: opts?.id ?? `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: toolName,
          args,
        },
      },
      { type: 'done', usage: opts?.usage ?? { inputTokens: 15, outputTokens: 10 } },
    ],
  };
}

/** Convenience: create a turn with text followed by tool_use. */
export function textAndToolTurn(
  text: string,
  toolName: string,
  args: Record<string, unknown>,
  opts?: { toolId?: string },
): LLMTurn {
  return {
    chunks: [
      { type: 'text', content: text },
      {
        type: 'tool_use',
        toolCall: {
          id: opts?.toolId ?? `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: toolName,
          args,
        },
      },
      { type: 'done', usage: { inputTokens: 20, outputTokens: 15 } },
    ],
  };
}

/** Convenience: match on the last user message containing a substring. */
export function matchLastMessage(substring: string): (req: ChatRequest) => boolean {
  return (req) => {
    const lastMsg = req.messages[req.messages.length - 1];
    if (!lastMsg) return false;
    const content = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : lastMsg.content.map(b => ('text' in b ? b.text : b.type === 'tool_result' ? b.content : '')).join('');
    return content.includes(substring);
  };
}

/** Convenience: match when any message contains a tool_result. */
export function matchHasToolResult(): (req: ChatRequest) => boolean {
  return (req) =>
    req.messages.some(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')
    );
}

// ─── Recorded Call ───────────────────────────────────

export interface RecordedLLMCall {
  request: ChatRequest;
  turnIndex: number;
  timestamp: number;
}

// ─── ScriptedLLM Class ──────────────────────────────

export class ScriptedLLM implements LLMProvider {
  readonly name = 'scripted';
  private sequentialTurns: LLMTurn[];
  private conditionalTurns: LLMTurn[];
  private sequentialIndex = 0;
  private fallbackTurn: LLMTurn;
  readonly calls: RecordedLLMCall[] = [];

  constructor(turns: LLMTurn[], fallback?: LLMTurn) {
    this.sequentialTurns = turns.filter(t => !t.match);
    this.conditionalTurns = turns.filter(t => t.match);
    this.fallbackTurn = fallback ?? textTurn('[ScriptedLLM: no matching turn]');
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    // 1. Try conditional turns (first match wins, consumed once)
    const condIdx = this.conditionalTurns.findIndex(t => t.match!(req));
    if (condIdx >= 0) {
      const turn = this.conditionalTurns.splice(condIdx, 1)[0]!;
      this.calls.push({ request: req, turnIndex: -1, timestamp: Date.now() });
      for (const chunk of turn.chunks) yield chunk;
      return;
    }

    // 2. Try sequential turns
    if (this.sequentialIndex < this.sequentialTurns.length) {
      const turn = this.sequentialTurns[this.sequentialIndex]!;
      this.calls.push({ request: req, turnIndex: this.sequentialIndex, timestamp: Date.now() });
      this.sequentialIndex++;
      for (const chunk of turn.chunks) yield chunk;
      return;
    }

    // 3. Fallback
    this.calls.push({ request: req, turnIndex: -999, timestamp: Date.now() });
    for (const chunk of this.fallbackTurn.chunks) yield chunk;
  }

  async models(): Promise<string[]> {
    return ['scripted-mock'];
  }

  /** How many times was chat() called? */
  get callCount(): number {
    return this.calls.length;
  }

  /** Get the last recorded call. */
  get lastCall(): RecordedLLMCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** Reset state for reuse. */
  reset(turns?: LLMTurn[]): void {
    if (turns) {
      this.sequentialTurns = turns.filter(t => !t.match);
      this.conditionalTurns = turns.filter(t => t.match);
    }
    this.sequentialIndex = 0;
    this.calls.length = 0;
  }
}
