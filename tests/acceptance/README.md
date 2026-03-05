# Acceptance Tests

Manual acceptance tests that validate AX features against their original design plans using a real running server with real LLM calls.

These are different from the unit tests (`tests/`) and E2E tests (`tests/e2e/`) which use mocked LLMs and in-memory harnesses. Acceptance tests catch the gaps between what a plan specified and what was actually built.

## Environments

Tests can run against two environments to validate that features work identically across deployment targets:

| Environment | Sandbox | EventBus | Storage | Config | Send method |
|-------------|---------|----------|---------|--------|-------------|
| **Local** | seatbelt | inprocess | sqlite | `fixtures/ax.yaml` | `tsx src/cli/index.ts send` via Unix socket |
| **K8s (kind)** | k8s-pod | nats | sqlite | `fixtures/ax-k8s.yaml` | `curl` to port-forwarded HTTP API |

The same test plans and assertions apply to both environments. Only the send commands and side-effect checks differ (local file access vs `kubectl exec`).

## How to run

Use the `acceptance-test` Claude Code skill. It will walk you through selecting a feature, designing tests, choosing an environment, executing them, and producing a fix list.

## Test isolation

### Local

Acceptance tests **always run in an isolated temporary `AX_HOME`** under `/tmp/` — never against the user's real `~/.ax` directory. The skill handles this automatically:

1. Creates `/tmp/ax-acceptance-<timestamp>/`
2. Copies config from `fixtures/ax.yaml` and credentials from `.env.test`
3. Copies identity files (`IDENTITY.md`, `SOUL.md`) and removes `BOOTSTRAP.md` to skip first-run bootstrapping
4. Starts the server with `AX_HOME` pointing to the temp directory
5. All test commands use `AX_HOME=$TEST_HOME` to stay isolated

### K8s (kind)

K8s tests deploy to a dedicated `ax-acceptance` namespace:

1. Creates a kind cluster (`ax-acceptance`)
2. Builds and loads the AX Docker image
3. Deploys via Helm using `fixtures/kind-values.yaml` (simplified single-pod setup — no agent-runtime or pool-controller)
4. Copies identity files into the running pod
5. Port-forwards `svc/ax-host` to `localhost:18080`
6. Tests send messages via HTTP API and check side effects via `kubectl exec`

## Tailing logs

### Local

Start the server with `LOG_SYNC=1` so pino writes synchronously to the log file:

```bash
AX_HOME="$TEST_HOME" LOG_LEVEL=debug LOG_SYNC=1 NODE_NO_WARNINGS=1 \
  tsx src/cli/index.ts serve > "$TEST_HOME/server-stdout.log" 2>&1 &
```

Then tail in another terminal:

```bash
tail -f /tmp/ax-acceptance-*/data/ax.log
```

Without `LOG_SYNC=1`, pino buffers ~4KB before flushing and `tail -f` appears to hang.

### K8s

```bash
HOST_POD=$(kubectl -n ax-acceptance get pod \
  -l app.kubernetes.io/component=host \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-acceptance logs -f "$HOST_POD"
```

## Directory structure

```
tests/acceptance/
  fixtures/
    ax.yaml             # Local test config (seatbelt, inprocess, sqlite)
    ax-k8s.yaml         # K8s test config (k8s-pod, nats, sqlite)
    kind-values.yaml    # Helm overrides for kind cluster
    IDENTITY.md         # Deterministic agent identity
    SOUL.md             # Deterministic agent personality
    .env.test.example   # Template for API keys
  <feature-name>/
    test-plan.md        # Test cases designed from the plan's acceptance criteria
    results-local.md    # Execution results for local environment
    results-k8s.md      # Execution results for k8s environment
    fixes.md            # Prioritized list of issues to fix
```

Each feature gets its own subdirectory. Test plans are reusable — you can re-run them after fixing issues to verify the fixes. Results are split by environment when running against both.

## Test categories

- **Structural (ST-*)**: Verify code shape, file existence, interface contracts. Fast and deterministic. Environment-independent — run once regardless of target. Can run in parallel.
- **Behavioral (BT-*)**: Verify feature works via chat interaction with the live server. Non-deterministic but tests real behavior. Must run sequentially.
- **Integration (IT-*)**: Verify multi-step flows, state persistence, cross-component interaction. Uses session persistence. Must run sequentially.

## Session ID format

AX session IDs require **3 or more colon-separated segments**:

```bash
# WRONG — rejected by server
--session "acceptance:bt1"

# CORRECT
--session "acceptance:memoryfs:bt1"
```

## Tips

- Start with structural tests — if the code isn't wired up correctly, behavioral tests will obviously fail.
- Run behavioral and integration tests sequentially to avoid SQLite contention.
- Check the audit log (`$TEST_HOME/data/audit.db` or via `kubectl exec`) for ground truth on what the server did during a request.
- When running both environments, compare results to find environment-specific failures. Local-only failures suggest sandbox/process issues; k8s-only failures suggest provider-level bugs in the k8s-pod sandbox or NATS eventbus.
- K8s testing is optional — validate features locally first, then use k8s to verify cross-environment compatibility.
