/**
 * Scripted turns for the indirect-dispatch smoke test.
 *
 * Purpose: prove the unified tool-dispatch loop wires end-to-end in
 * `indirect` mode (Phase 3 of the tool-dispatch-unification plan):
 *
 *   agent LLM → `call_tool` tool_call → agent IPC client → host
 *   `call_tool` handler → per-turn catalog lookup → structured result
 *   → back through IPC → rendered to the LLM → user-facing answer.
 *
 * This is a SMOKE test, not a full Linear integration. The e2e catalog
 * is empty (no skills installed with MCP servers), so the host's
 * `call_tool` handler returns `{error, kind: 'unknown_tool'}`. That
 * structured error travelling the full path is the evidence that
 * Phase 3 plumbing works — real MCP dispatch is Task 4.4's job.
 *
 * Why skip `describe_tools` first: the mock OpenRouter short-circuits
 * after a single tool result (see `handleChatCompletion`'s tool-result
 * follow-up branch), so we can only exercise ONE meta-tool per test.
 * `call_tool` is the higher-value path since it covers dispatch;
 * `describe_tools` is covered by unit tests already.
 */
import type { ScriptedTurn } from './types.js';

export const TOOL_DISPATCH_TURNS: ScriptedTurn[] = [
  // User says "list Linear issues via call_tool" — the LLM is scripted
  // to bypass `describe_tools` and dispatch directly through `call_tool`.
  // In the empty-catalog e2e environment, the host returns a structured
  // `unknown_tool` error; the mock OpenRouter's tool-result follow-up
  // path then produces the final user-facing summary.
  // The match is intentionally narrow — "indirect dispatch smoke" is a
  // phrase no other scripted turn uses, so turn-matching stays
  // deterministic regardless of which order earlier turns were consumed.
  {
    match: /indirect dispatch smoke/i,
    response: {
      content: 'Let me dispatch the Linear list-issues tool through call_tool.',
      tool_calls: [{
        id: 'tc_dispatch_1',
        type: 'function',
        function: {
          name: 'call_tool',
          arguments: JSON.stringify({
            tool: 'mcp_linear_list_issues',
            args: { limit: 5 },
          }),
        },
      }],
    },
  },
];
