/**
 * Scripted turns for the Task 7.5 Petstore 2-call OpenAPI flow.
 *
 * Proves the unified indirect-dispatch pipeline works end-to-end for
 * OpenAPI sources (Phase 7 parallel to the Linear/MCP flow in Task 4.4):
 *
 *   1. user → agent: "Create a pet named Rex and tell me its id."
 *   2. LLM emits `call_tool(api_petstore_create_pet, {body:{name:'Rex'}})`.
 *   3. Host dispatches via the OpenAPI dispatcher; mock returns
 *      `{id:42, name:'Rex'}` (determinism: `name === 'Rex'` always gets
 *      `id=42` — see `petstore.ts`).
 *   4. LLM emits `call_tool(api_petstore_get_pet_by_id, {id: 42})`.
 *   5. Mock returns `{id:42, name:'Rex', _readback:true}`. The
 *      `_readback` field is a mock-only sentinel that disambiguates the
 *      read-back from the create response; without it the two payloads
 *      are shape-identical and the mock OpenRouter's first-match-wins
 *      iteration order would make Turn 2 fire on its own output.
 *   6. LLM emits final content summary naming the id.
 *
 * Catalog tool names:
 *   - `api_petstore_list_pets`
 *   - `api_petstore_create_pet`
 *   - `api_petstore_get_pet_by_id`   (`getPetByID` snake-cases to
 *     `get_pet_by_id` — the adapter's `toSnakeCase` collapses trailing
 *     acronyms; verified against `toSnakeCase` unit tests in Task 7.2.)
 *   - `api_petstore_delete_pet`
 *
 * Match-pattern discipline:
 *   - Turn 1 requires "rex" AND a create verb — avoids collisions with
 *     any other scripted turn mentioning pets in passing.
 *   - Turn 2's `matchToolResult` keys on `"id":42` AND `"name":"Rex"`
 *     — nothing in the Linear flow returns that pair.
 *   - Turn 3's `matchToolResult` keys on `"_readback":true` — only the
 *     read-back response carries this, so Turn 2 can't re-fire.
 */

import type { ScriptedTurn } from './types.js';

export const PETSTORE_FLOW_TURNS: ScriptedTurn[] = [
  // Turn 1 — user asks to create Rex; LLM dispatches createPet.
  {
    match: /create.*pet.*rex|pet.*named rex|create a pet named rex/i,
    response: {
      content: "I'll create the pet and then read it back to confirm.",
      tool_calls: [{
        id: 'tc_petstore_create_pet',
        type: 'function',
        function: {
          name: 'call_tool',
          arguments: JSON.stringify({
            tool: 'api_petstore_create_pet',
            args: { body: { name: 'Rex' } },
          }),
        },
      }],
    },
  },

  // Turn 2 — createPet returned {id:42, name:'Rex'}; LLM chains to
  // getPetByID. `matchToolResult` pins both id=42 and name="Rex" so the
  // listPets tool return (which also mentions Rex, but with id=1) can't
  // accidentally trigger this chain.
  {
    match: '__petstore_flow_never_match_user__',
    matchToolResult: /"id"\s*:\s*42[\s\S]*"name"\s*:\s*"Rex"/,
    response: {
      content: 'Got id 42. Reading it back.',
      tool_calls: [{
        id: 'tc_petstore_get_pet_by_id',
        type: 'function',
        function: {
          name: 'call_tool',
          arguments: JSON.stringify({
            tool: 'api_petstore_get_pet_by_id',
            args: { id: 42 },
          }),
        },
      }],
    },
  },

  // Turn 3 — getPetByID returned the pet with `_readback:true`; LLM
  // emits final summary. Keyed on `"_readback":true` so Turn 2 doesn't
  // re-fire against its own getPetByID result.
  {
    match: '__petstore_flow_never_match_user__',
    matchToolResult: /"_readback"\s*:\s*true/,
    response: {
      content: 'Created pet Rex with id 42.',
    },
  },
];
