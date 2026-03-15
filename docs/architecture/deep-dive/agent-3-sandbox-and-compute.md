# Agent 3 Report — Sandbox and Compute Topologies

## 1) Canonical mount contract

AX standardizes sandbox-visible paths to canonical mount points:

- `/workspace` (root)
- `/workspace/scratch` (session working set)
- `/workspace/agent` (agent scope)
- `/workspace/user` (user scope)

This hides host filesystem details and keeps prompts/tool instructions stable across providers.

## 2) Apple container provider (macOS)

Apple provider runs each sandbox inside a lightweight VM via `container run`:

- mounts scratch and optional agent/user scopes using `-v`
- bridges IPC through `--publish-socket` and a container-side socket
- sets `AX_IPC_LISTEN=1` so the agent listens in-container
- intentionally avoids container networking by default (no `--network` flag)

Important implementation nuance:

- `--publish-socket` forwarding depends on listener readiness and socket path behavior
- comments document why read-only root/tmpfs tradeoffs were made to keep socket forwarding reliable

## 3) Kubernetes sandbox provider

k8s provider creates per-sandbox pods with:

- strict container securityContext
- resource requests/limits
- NATS connectivity env
- canonical workspace mounts via `emptyDir` volumes (scratch/tmp/agent/user)

Host communicates via k8s Attach for stdin/stdout semantics equivalent to local subprocess flow.

## 4) Split-plane k8s architecture

In k8s deployments, sandbox tool execution is delegated through NATS:

- dispatcher claims warm worker pod (`tasks.sandbox.<tier>`)
- worker handles tool calls on pod-specific subject
- turn-scoped pod affinity keeps multi-tool turns coherent
- release returns pod to pool and may emit workspace staging metadata

This design separates:

- host/orchestration policy
- agent runtime control loop
- sandbox worker execution

## 5) Network and trust observations

- Apple container mode defaults to no sandbox network.
- k8s pod networking depends on cluster/network policies, but credentials still remain host/runtime-side.
- LLM API egress for claude-code in k8s flows through runtime NATS LLM proxy, not directly from tool workers.
