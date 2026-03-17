## [2026-03-17 12:00] — Fix run-http-local.ts missing k8s HTTP routes

**Task:** Debug why LLM responses hang and identity isn't saved when running in real k8s clusters
**What I did:** Identified that `tests/providers/sandbox/run-http-local.ts` was missing three critical HTTP routes that `src/host/host-process.ts` provides:
1. `/internal/llm-proxy/*` — LLM credential injection proxy (claude-code sets ANTHROPIC_BASE_URL here)
2. `/internal/workspace/release` — Direct workspace file upload from agent pods
3. `/internal/workspace-staging` — Legacy two-phase workspace upload

Also added `workspace_release` IPC intercept in the wrappedHandleIPC function for the legacy staging path.

Updated the `ax-debug` SKILL.md with detailed debugging guidance for specific symptoms (LLM hanging, identity not saved, workspace release failures).

**Files touched:**
- `tests/providers/sandbox/run-http-local.ts` — Added 3 HTTP routes + workspace_release IPC intercept + gunzipSync import + staging store
- `.claude/skills/ax-debug/SKILL.md` — Rewrote with production-accurate route surface, debugging steps per symptom, updated file references

**Outcome:** Success — debug harness now mirrors the full host-process.ts route surface for k8s HTTP IPC mode
**Notes:** The root cause of LLM hanging was that claude-code runner sets `ANTHROPIC_BASE_URL=${AX_HOST_URL}/internal/llm-proxy` but the harness had no such route, so agent LLM calls got 404s and hung. Similarly, workspace release and identity writes require the workspace HTTP endpoints.
