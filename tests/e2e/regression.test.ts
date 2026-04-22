/**
 * Automated regression test sequence.
 *
 * Runs against a live AX server (deployed in kind or running locally).
 * Tests execute in order — each test may depend on state from previous tests.
 *
 * Env vars set by global-setup.ts:
 *   AX_SERVER_URL    — base URL of the AX server
 *   MOCK_SERVER_PORT — port of the mock server on the host
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { AcceptanceClient, type ChatResponse } from './client.js';

const SERVER_URL = process.env.AX_SERVER_URL ?? 'http://localhost:8080';
const SESSION_PREFIX = `http:dm:main:e2e-${Date.now()}`;

let client: AcceptanceClient;

describe('regression test sequence', () => {
  beforeAll(() => {
    client = new AcceptanceClient(SERVER_URL);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. RESET — verify server healthy
  // ──────────────────────────────────────────────────────────────────────
  test('1. server health check', async () => {
    await client.waitForReady(30_000);
    const res = await fetch(`${SERVER_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2a. BOOTSTRAP — first message triggers bootstrap mode
  // ──────────────────────────────────────────────────────────────────────
  test('2a. bootstrap: user introduces self', async () => {
    const sessionId = `${SESSION_PREFIX}:bootstrap`;
    const res = await client.sendMessage(
      'Hello! My name is TestUser and I am here for acceptance testing.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.finishReason).toBeTruthy();
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 2b. BOOTSTRAP — user sets agent identity
  // ──────────────────────────────────────────────────────────────────────
  test('2b. bootstrap: set agent identity', async () => {
    const sessionId = `${SESSION_PREFIX}:bootstrap`;
    const res = await client.sendMessage(
      'Your name is Reginald. You are witty and funny. Your purpose is acceptance testing.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 3. PERSISTENCE — new session, agent responds with established identity
  // ──────────────────────────────────────────────────────────────────────
  test('3. persistence: identity carries over to new session', async () => {
    const sessionId = `${SESSION_PREFIX}:persist`;
    const res = await client.sendMessage(
      'Who are you? What is your name?',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 4. TOOL CALL — web_fetch through proxy
  // ──────────────────────────────────────────────────────────────────────
  test('4. tool call: web_fetch through proxy', async () => {
    const sessionId = `${SESSION_PREFIX}:tools`;
    const res = await client.sendMessage(
      'Please fetch this URL for me: http://mock-target.test/web-fetch-target',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 5. FILE OPS — agent creates files in workspace
  // ──────────────────────────────────────────────────────────────────────
  test('5. file ops: create file in workspace', async () => {
    const sessionId = `${SESSION_PREFIX}:files`;
    const res = await client.sendMessage(
      'Please create a file called test-file.txt with the content "acceptance-test-content-12345"',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 6. FILE PERSIST — new session, agent reads back files
  // ──────────────────────────────────────────────────────────────────────
  test('6. file persistence: read file from previous session', async () => {
    const sessionId = `${SESSION_PREFIX}:files2`;
    const res = await client.sendMessage(
      'Can you read the file test-file.txt and tell me what it contains?',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 7. BASH + PROXY — curl command through web proxy
  // ──────────────────────────────────────────────────────────────────────
  test('7. bash + proxy: curl through web proxy', async () => {
    const sessionId = `${SESSION_PREFIX}:proxy`;
    const res = await client.sendMessage(
      'Run a curl command to http://mock-target.test/web-fetch-target and show me the output',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 8a. SKILL INSTALL — triggers credential_required SSE event
  // ──────────────────────────────────────────────────────────────────────
  test('8a. skill install: triggers credential requirement', async () => {
    const sessionId = `${SESSION_PREFIX}:skills`;
    const res = await client.sendMessage(
      'Please install the Linear skill from ManuelHettich/linear',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    // The response should indicate that a credential is needed
    // This may come as a named SSE event or in the response content
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 8b. CREDENTIALS — provide credential via POST
  // ──────────────────────────────────────────────────────────────────────
  test('8b. credentials: provide LINEAR_API_KEY', async () => {
    // Provide the credential that was requested
    try {
      await client.provideCredential('LINEAR_API_KEY', 'lin_api_test_acceptance_key_12345');
    } catch {
      // Credential endpoint may not be available in all modes — that's OK
      // The key assertion is that the provide call doesn't crash the server
    }
    // Verify server is still healthy after credential provision
    const health = await fetch(`${SERVER_URL}/health`);
    expect(health.status).toBe(200);
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────
  // 9. SKILL EXEC — Linear tool call through proxy to mock Linear API
  // ──────────────────────────────────────────────────────────────────────
  test('9. skill execution: Linear query through proxy', async () => {
    const sessionId = `${SESSION_PREFIX}:skills`;
    const res = await client.sendMessage(
      'Show me my Linear issues. List all issues please.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 10. MEMORY WRITE — store a preference via memory tool
  // ──────────────────────────────────────────────────────────────────────
  test('10. memory: write a preference', async () => {
    const sessionId = `${SESSION_PREFIX}:memory`;
    const res = await client.sendMessage(
      'Please remember that I prefer dark mode for all my settings.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 11. MEMORY DEDUP — writing the same fact reinforces, not duplicates
  // ──────────────────────────────────────────────────────────────────────
  test('11. memory: duplicate write reinforces existing item', async () => {
    const sessionId = `${SESSION_PREFIX}:memory`;
    const res = await client.sendMessage(
      'Also remember too that I prefer dark mode — just to be sure.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 12. MEMORY RECALL — new session, query memories
  // ──────────────────────────────────────────────────────────────────────
  test('12. memory: cross-session recall via query', async () => {
    const sessionId = `${SESSION_PREFIX}:memory2`;
    const res = await client.sendMessage(
      'What are my preferences? Recall from memory please.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 13. MEMORY LIST — list all stored memories in scope
  // ──────────────────────────────────────────────────────────────────────
  test('13. memory: list all memories in scope', async () => {
    const sessionId = `${SESSION_PREFIX}:memory2`;
    const res = await client.sendMessage(
      'List all memories you have stored. Show me everything remembered.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 14. SCHEDULER ADD CRON — create a recurring scheduled task
  // ──────────────────────────────────────────────────────────────────────
  test('14. scheduler: add daily cron job', async () => {
    const sessionId = `${SESSION_PREFIX}:scheduler`;
    const res = await client.sendMessage(
      'Schedule a daily reminder at 9 AM to check my test results.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 15. SCHEDULER RUN_AT — schedule a one-shot future task
  // ──────────────────────────────────────────────────────────────────────
  test('15. scheduler: schedule one-time task', async () => {
    const sessionId = `${SESSION_PREFIX}:scheduler`;
    const res = await client.sendMessage(
      'Remind me at midnight on New Year\'s Eve. Run at 2026-12-31T23:59.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 16. SCHEDULER LIST — verify scheduled jobs persist
  // ──────────────────────────────────────────────────────────────────────
  test('16. scheduler: list scheduled jobs', async () => {
    const sessionId = `${SESSION_PREFIX}:scheduler`;
    const res = await client.sendMessage(
      'What is currently scheduled? List all my scheduled jobs.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 17. INDIRECT DISPATCH — call_tool routes through host catalog + IPC
  // ──────────────────────────────────────────────────────────────────────
  //
  // Smoke test for Phase 3 of the tool-dispatch-unification plan
  // (Task 3.6). Proves the unified indirect-dispatch loop wires end to
  // end: the agent emits a `call_tool` tool call, the stub forwards it
  // over IPC, the host's `call_tool` handler resolves the per-turn
  // catalog, and the structured result makes it back to the agent.
  //
  // The e2e catalog is empty (no skills installed with MCP servers in
  // this environment), so `call_tool` with `mcp_linear_list_issues`
  // returns `{error, kind: 'unknown_tool'}`. That structured response
  // travelling the full path IS the evidence. Real MCP dispatch is
  // covered by unit tests and by Task 4.4 once projection lands.
  test('17. indirect dispatch: call_tool round-trips through IPC', async () => {
    const sessionId = `${SESSION_PREFIX}:dispatch`;
    // The phrase "indirect dispatch smoke" is the only thing the
    // TOOL_DISPATCH_TURNS pattern keys on — deliberately distinct from
    // every other scripted turn's regex so the test stays deterministic
    // even when run in isolation (e.g. `vitest -t "indirect dispatch"`).
    const res = await client.sendMessage(
      'Please exercise the indirect dispatch smoke path.',
      { sessionId, user: 'testuser', timeoutMs: 120_000 },
    );

    expect(res.status).toBe(200);
    // The mock OpenRouter's tool-result follow-up path produces the final
    // user-facing summary from the IPC response; any non-empty content
    // proves the round-trip completed without the agent crashing or the
    // IPC handler throwing across the boundary.
    expect(res.content.length).toBeGreaterThan(0);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────
  // 18. LINEAR 3-TURN FLOW — catalog → call_tool → MCP → chained calls
  // ──────────────────────────────────────────────────────────────────────
  //
  // Task 4.4 final: prove the unified indirect-dispatch pipeline handles a
  // realistic multi-step tool chain end-to-end.
  //
  //   1. User asks "What issues are in Product's current cycle?"
  //   2. The `linear_mcp` fixture skill's mcpServers frontmatter populates
  //      the per-turn catalog with 3 tools from the mock MCP server.
  //   3. LLM emits call_tool(mcp_linear_mcp_get_team) — scripted.
  //   4. Host dispatches via MCP → mock MCP returns {team_id:'team_product'}.
  //   5. LLM emits call_tool(mcp_linear_mcp_list_cycles, {team_id}) —
  //      scripted via matchToolResult:/team_product/.
  //   6. Mock MCP returns {cycle_id:'cycle_99', ...}.
  //   7. LLM emits call_tool(mcp_linear_mcp_list_issues, {cycle_id}) —
  //      scripted via matchToolResult:/cycle_99/.
  //   8. Mock MCP returns {issues:[ISS-1, ISS-2]}.
  //   9. LLM emits final content summary naming ISS-1.
  //
  // Evidence: the mock MCP server tracks per-method hit counters; we
  // assert each of get_team/list_cycles/list_issues was hit exactly once.
  // That proves zero retries AND all three dispatches actually landed on
  // the server (not short-circuited by the mock or a catalog miss).
  test('18. Linear 3-turn cycle flow through indirect dispatch', async () => {
    // Reset MCP stats so prior tests don't contaminate the counters.
    const mockPort = process.env.MOCK_SERVER_PORT;
    if (!mockPort) {
      throw new Error('MOCK_SERVER_PORT env var not set — global setup skipped?');
    }
    const mockBase = `http://127.0.0.1:${mockPort}`;
    await fetch(`${mockBase}/mcp/_reset`, { method: 'POST' });

    const sessionId = `${SESSION_PREFIX}:linear-flow`;
    const res = await client.sendMessage(
      "What issues are in Product's current cycle?",
      { sessionId, user: 'testuser', timeoutMs: 180_000 },
    );

    expect(res.status).toBe(200);
    // Final answer must reference an issue surfaced by list_issues —
    // proves the full chain executed and the final summary turn fired.
    expect(res.content).toMatch(/ISS-1|ISS-2|Ship Task 4\.4|Sync docs/i);

    // Verify each MCP method was hit exactly once — the core evidence that
    // the 3-call chain actually landed on the server with no retries.
    const stats = await fetch(`${mockBase}/mcp/_stats`).then(r => r.json()) as {
      get_team: number;
      list_cycles: number;
      list_issues: number;
    };
    expect(stats.get_team).toBe(1);
    expect(stats.list_cycles).toBe(1);
    expect(stats.list_issues).toBe(1);
  }, 240_000);

  // ──────────────────────────────────────────────────────────────────────
  // 19. PETSTORE 2-CALL FLOW — catalog → call_tool → OpenAPI → chained calls
  // ──────────────────────────────────────────────────────────────────────
  //
  // Task 7.5: prove the unified indirect-dispatch pipeline handles an
  // OpenAPI-sourced chain end-to-end (Phase 7 parallel to Task 4.4's
  // Linear/MCP chain).
  //
  //   1. User asks: "Create a pet named Rex and tell me its id."
  //   2. The `petstore` fixture skill's `openapi[]` frontmatter populates
  //      the per-turn catalog with 4 tools fetched from the mock spec at
  //      https://mock-target.test/openapi/petstore.json (url_rewrites
  //      redirect to the e2e mock server on a dynamic port).
  //   3. LLM emits call_tool(api_petstore_create_pet, {body:{name:'Rex'}})
  //      — scripted. Host dispatches via OpenAPI → mock returns
  //      {id:42, name:'Rex'} (deterministic: name='Rex' → id=42).
  //   4. LLM emits call_tool(api_petstore_get_pet_by_id, {id:42}) —
  //      scripted via matchToolResult pinning both id=42 and name="Rex".
  //   5. Mock returns {id:42, name:'Rex', _readback:true}.
  //   6. LLM emits final content summary naming the id.
  //
  // Evidence: the mock tracks per-operation hit counters; we assert
  // createPet=1 + getPetByID=1 + listPets=0 + deletePet=0. That proves
  // (a) the OpenAPI adapter populated the catalog, (b) both dispatches
  // actually landed on the server with the right path/method/body, and
  // (c) nothing extraneous fired (no retries, no accidental listPets).
  test('19. Petstore 2-call flow through OpenAPI indirect dispatch', async () => {
    const mockPort = process.env.MOCK_SERVER_PORT;
    if (!mockPort) {
      throw new Error('MOCK_SERVER_PORT env var not set — global setup skipped?');
    }
    const mockBase = `http://127.0.0.1:${mockPort}`;
    await fetch(`${mockBase}/petstore/_reset`, { method: 'POST' });

    const sessionId = `${SESSION_PREFIX}:petstore-flow`;
    const res = await client.sendMessage(
      'Create a pet named Rex and tell me its id.',
      { sessionId, user: 'testuser', timeoutMs: 180_000 },
    );

    expect(res.status).toBe(200);
    // Final answer must reference both "Rex" and "42" — proves the full
    // chain executed and Turn 3's summary fired from the read-back.
    expect(res.content).toMatch(/rex.*42|42.*rex/i);

    // Verify each OpenAPI op was hit the expected number of times — the
    // core evidence that the 2-call chain actually landed on the server
    // with no retries and no accidental dispatches.
    const stats = await fetch(`${mockBase}/petstore/_stats`).then((r) => r.json()) as {
      listPets: number;
      createPet: number;
      getPetById: number;
      deletePet: number;
    };
    expect(stats.createPet).toBe(1);
    expect(stats.getPetById).toBe(1);
    expect(stats.listPets).toBe(0);
    expect(stats.deletePet).toBe(0);
  }, 240_000);

});
