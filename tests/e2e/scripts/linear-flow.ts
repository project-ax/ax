/**
 * Scripted turns for the Task 4.4 Linear 3-turn cycle flow.
 *
 * Proves the unified indirect-dispatch pipeline works end-to-end:
 *   1. user → agent: "What issues are in Product's current cycle?"
 *   2. LLM emits `call_tool(mcp_linear_mcp_get_team)` — first MCP call
 *   3. host returns {team_id: 'team_product', name: 'Product'}
 *   4. LLM emits `call_tool(mcp_linear_mcp_list_cycles, {team_id})` — second
 *   5. host returns {cycle_id: 'cycle_99', ...}
 *   6. LLM emits `call_tool(mcp_linear_mcp_list_issues, {cycle_id})` — third
 *   7. host returns {issues: [ISS-1, ISS-2]}
 *   8. LLM emits final content summary naming the issues
 *
 * The key invariant: the mock OpenRouter must pick the right scripted turn
 * based on which tool JUST returned. The `matchToolResult` field handles
 * this — each turn after the opening one pattern-matches against the
 * previous tool's JSON payload.
 *
 * The catalog tool name is `mcp_<skillName>_<toolName>` — with skill name
 * `linear_mcp` (underscore, not hyphen — the catalog enforces
 * /^(mcp|api)_[a-z0-9_]+$/ for tool names) and tool names
 * `get_team`, `list_cycles`, `list_issues`.
 */

import type { ScriptedTurn } from './types.js';

export const LINEAR_FLOW_TURNS: ScriptedTurn[] = [
  // Turn 1 — user asks about current cycle issues; LLM dispatches get_team.
  {
    match: /current cycle.*issues|issues.*current cycle|product's current cycle/i,
    response: {
      content: "I'll look up the Product team first, then its current cycle, then the issues.",
      tool_calls: [{
        id: 'tc_linear_get_team',
        type: 'function',
        function: {
          name: 'call_tool',
          arguments: JSON.stringify({
            tool: 'mcp_linear_mcp_get_team',
            args: {},
          }),
        },
      }],
    },
  },
  // Turn 2 — get_team just returned team_product; LLM chains to list_cycles.
  {
    match: '__linear_flow_never_match_user__',
    matchToolResult: /team_product/,
    response: {
      content: 'Got the team. Fetching its current cycle.',
      tool_calls: [{
        id: 'tc_linear_list_cycles',
        type: 'function',
        function: {
          name: 'call_tool',
          arguments: JSON.stringify({
            tool: 'mcp_linear_mcp_list_cycles',
            args: { team_id: 'team_product' },
          }),
        },
      }],
    },
  },
  // Turn 3 — list_cycles returned cycle_99; LLM chains to list_issues.
  {
    match: '__linear_flow_never_match_user__',
    matchToolResult: /cycle_99/,
    response: {
      content: 'Got the current cycle. Listing its issues.',
      tool_calls: [{
        id: 'tc_linear_list_issues',
        type: 'function',
        function: {
          name: 'call_tool',
          arguments: JSON.stringify({
            tool: 'mcp_linear_mcp_list_issues',
            args: { cycle_id: 'cycle_99' },
          }),
        },
      }],
    },
  },
  // Turn 4 — list_issues returned {issues: [...]}; LLM emits final summary.
  //
  // Discriminator: match on "Ship Task 4.4" (list_issues-only substring, not
  // in get_team or list_cycles responses) to avoid colliding with Turn 2/3
  // patterns.
  {
    match: '__linear_flow_never_match_user__',
    matchToolResult: /Ship Task 4\.4/,
    response: {
      content: "The Product team's current cycle (Cycle 14) has 2 issues: ISS-1 (Ship Task 4.4) and ISS-2 (Sync docs).",
    },
  },
];
