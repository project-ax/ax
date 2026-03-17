## [2026-03-17 08:35] — HTTP IPC end-to-end test harness

**Task:** Test HttpIPCClient end-to-end using the ax-debug skill infrastructure
**What I did:**
1. Added `ipcTransport: 'http'` option to `nats-subprocess.ts` sandbox provider
2. Created `run-http-local.ts` — minimal host process with `/internal/ipc` route, per-turn token auth, NATS work publishing with retry
3. Fixed race condition: agent needs time to connect to NATS before host publishes work → use `nc.request()` with retry loop instead of fire-and-forget `nc.publish()`
4. Updated `ax-debug` skill with HTTP IPC quick start, message flow, and key files
**Files touched:** `tests/providers/sandbox/nats-subprocess.ts`, `tests/providers/sandbox/run-http-local.ts` (new), `.claude/skills/ax-debug/SKILL.md`
**Outcome:** Success — full end-to-end flow works: curl → host → NATS work delivery → agent HttpIPCClient → HTTP IPC calls → agent_response → curl response
**Notes:** Non-fatal `__dirname is not defined` in workspace-release when running via tsx (ESM mode). The harness can't use `createServer()` from server.ts because it lacks `/internal/ipc` route and NATS publishing; had to build a minimal host process.

## [2026-03-17 06:25] — K8s networking simplification: NATS queue groups + HTTP gateway

**Task:** Consolidate k8s agent↔host networking from 5+ transport mechanisms into two clean layers — NATS for work dispatch, HTTP for all data exchange.
**What I did:** Implemented 11 tasks:
1. Agent waitForNATSWork() → queue group subscription on sandbox.work
2. Host publishWork → nc.request('sandbox.work') for warm pool claiming
3. Deleted warm-pool-client.ts, removed 'claimed' from PodPoolStatus
4. Created HttpIPCClient (fetch() POST to /internal/ipc)
5. Added /internal/ipc route with activeTokens registry
6. Wired http transport branch in runner.ts, changed AX_IPC_TRANSPORT to http
7. Created llm-proxy-core.ts, added /internal/llm-proxy route
8. claude-code runner direct HTTP LLM proxy (no bridge process)
9. Single HTTP POST workspace release (/internal/workspace/release)
10. Removed per-turn NATS IPC handler and LLM proxy from host
11. Deleted nats-ipc-client.ts, nats-bridge.ts, nats-ipc-handler.ts, nats-llm-proxy.ts

**Files touched:** 37 files (see git diff), net -768 lines
**Outcome:** Success — all 2493 tests pass, 11 clean commits
**Notes:** Docker/apple/subprocess sandboxes completely untouched. NATS kept only for queue group work dispatch.
