# E2E Tests: Switch to K8s Sandbox with NATS Work Dispatch

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Switch e2e regression tests from `subprocess` sandbox to `k8s` sandbox, using NATS for work dispatch and HTTP for IPC — exercising the real K8s pod lifecycle in kind.

**Architecture:** The host pod (`server-k8s.js`) spawns sandbox pods via the K8s API. Each sandbox pod connects to NATS (`waitForNATSWork()`) for work dispatch and uses `HttpIPCClient` for IPC back to the host. The web proxy on the host pod handles outbound HTTP with `url_rewrites` routing mock domains to the host-side mock server.

**Tech Stack:** kind, Helm, NATS, K8s API, vitest

---

### Task 1: Update kind-values.yaml for K8s Sandbox

**Files:**
- Modify: `tests/e2e/kind-values.yaml`

**Step 1: Switch sandbox provider and enable web proxy service**

Change:
```yaml
# WAS:
  providers:
    ...
    sandbox: subprocess

# NOW:
  providers:
    ...
    sandbox: k8s
```

Add web proxy service (needed so sandbox pods can reach the proxy via K8s Service DNS):
```yaml
webProxy:
  enabled: true
```

Remove stale `agentRuntime` block (no template uses it):
```yaml
# REMOVE:
agentRuntime:
  enabled: true
```

**Step 2: Verify the file**

The final `kind-values.yaml` should have:
- `config.providers.sandbox: k8s`
- `webProxy.enabled: true`
- `poolController.enabled: false` (unchanged — cold start only)
- `sandbox.runtimeClass: ""` (unchanged — no gvisor in kind)
- `networkPolicies.enabled: false` (unchanged)
- No `agentRuntime` block

**Step 3: Commit**

```bash
git add tests/e2e/kind-values.yaml
git commit -m "feat(e2e): switch sandbox from subprocess to k8s in kind-values"
```

---

### Task 2: Add Dynamic url_rewrites to global-setup.ts

**Files:**
- Modify: `tests/e2e/global-setup.ts`

**Step 1: Add url_rewrites --set flags to the Helm install command**

In the `setup()` function, find the `run('helm', [...])` call and add `--set` flags for url_rewrites. These route `mock-target.test` and `api.linear.app` through the web proxy to the host mock server.

Add these after the existing `--set` flags:
```typescript
'--set', `config.url_rewrites.mock-target\\.test=${mockBaseUrl}`,
'--set', `config.url_rewrites.api\\.linear\\.app=${mockBaseUrl}`,
```

Note: `\\.` escapes dots in Helm key names (so `mock-target.test` is treated as a single key, not nested path).

**Step 2: Increase rollout and health timeouts**

K8s sandbox mode is slower (NATS init job, pod scheduling). Change:

- Rollout timeout: `180s` → `300s`
- Health check timeout: `120_000` → `180_000`
- Helm `--timeout`: `180s` → `300s`

**Step 3: Verify no other changes needed**

The rest of global-setup.ts (Docker build, image load, port-forward, secret creation) remains the same — the same Docker image is used for both host and sandbox pods.

**Step 4: Commit**

```bash
git add tests/e2e/global-setup.ts
git commit -m "feat(e2e): add url_rewrites and increase timeouts for k8s sandbox"
```

---

### Task 3: Increase Test Timeouts

**Files:**
- Modify: `tests/e2e/vitest.config.ts`
- Modify: `tests/e2e/regression.test.ts`

**Step 1: Increase vitest global timeout**

K8s sandbox cold-starts a pod per request (~15-30s overhead). Increase timeouts:

```typescript
// vitest.config.ts
test: {
  testTimeout: 180_000,       // 3 min per test (was 2 min)
  hookTimeout: 600_000,       // 10 min for globalSetup (was 5 min)
}
```

**Step 2: Increase per-test timeouts in regression.test.ts**

Change all `120_000` test timeouts to `180_000`:
- All `sendMessage` tests: `180_000` (was `120_000`)
- The `waitForReady` in test 1: leave at `30_000`
- The credential test (8b): leave at `30_000`

**Step 3: Increase `timeoutMs` on sendMessage calls**

Change all `timeoutMs: 90_000` to `timeoutMs: 120_000` in sendMessage options. This controls the SSE read timeout — K8s pod startup adds latency before the first SSE chunk arrives.

**Step 4: Commit**

```bash
git add tests/e2e/vitest.config.ts tests/e2e/regression.test.ts
git commit -m "feat(e2e): increase timeouts for k8s sandbox pod cold-start latency"
```

---

### Task 4: Update E2E Comment Header

**Files:**
- Modify: `tests/e2e/kind-values.yaml` (update comment at top)

**Step 1: Update the comment block**

```yaml
# Kind cluster overrides for automated regression tests
#
# Uses k8s sandbox with HTTP IPC and NATS work dispatch.
# Host pod creates sandbox pods via K8s API for each request.
# All external services mocked via mock-server on host.
# URL rewrites (set dynamically by global-setup.ts) redirect
# api.linear.app and mock-target.test to mock server.
```

**Step 2: Commit**

```bash
git add tests/e2e/kind-values.yaml
git commit -m "docs(e2e): update kind-values comment for k8s sandbox mode"
```

---

### Task 5: Run E2E Tests and Verify

**Step 1: Build**

```bash
npm run build
```

**Step 2: Run e2e tests**

```bash
npm run test:e2e
```

Expected: All 18 tests pass. Watch for:
- Pod creation logs in kind cluster
- NATS work dispatch (sandbox.work) messages
- HTTP IPC calls from sandbox pods to host
- Sandbox pods appearing and being cleaned up

**Step 3: If tests fail, debug**

Check pod logs:
```bash
kubectl logs -n ax-e2e -l app.kubernetes.io/name=ax-sandbox --tail=50
```

Check host logs:
```bash
kubectl logs -n ax-e2e deployment/ax-host --tail=100
```

Check NATS connectivity:
```bash
kubectl exec -n ax-e2e deployment/ax-host -- env | grep NATS
```

**Step 4: Final commit (squash if multiple fix commits)**

```bash
git add -A
git commit -m "feat(e2e): switch e2e tests from subprocess to k8s sandbox"
```

---

## File Change Summary

| File | Action | Change |
|------|--------|--------|
| `tests/e2e/kind-values.yaml` | Modify | `sandbox: k8s`, `webProxy.enabled: true`, remove `agentRuntime` |
| `tests/e2e/global-setup.ts` | Modify | Add `url_rewrites` `--set` flags, increase timeouts |
| `tests/e2e/vitest.config.ts` | Modify | Increase `testTimeout` and `hookTimeout` |
| `tests/e2e/regression.test.ts` | Modify | Increase per-test and SSE timeouts |
