---
name: ax-web-proxy
description: Use when debugging MITM proxy issues, credential placeholder replacement failures, proxy approval deadlocks, sandbox HTTPS connectivity problems, curl exit 60 SSL errors, ECONNRESET crashes in the proxy, or modifying extractNetworkDomains / web-proxy.ts / credential-placeholders.ts / web-proxy-approvals.ts
---

## Overview

The web proxy is a forward HTTP/HTTPS proxy running on the host that enables sandboxed agents (which have no direct outbound network) to make web requests. In MITM mode it terminates TLS, replaces `ax-cred:<hex>` credential placeholders with real values, scans for canary tokens, and forwards to the real server.

## Architecture

```
Agent sandbox pod (no port 443 egress)
  ↓ HTTP_PROXY / HTTPS_PROXY env vars
  ↓ curl/wget use proxy; Node.js fetch does NOT
MITM Proxy (host pod, port 3128)
  ├── Receives CONNECT host:443
  ├── Checks domain approval (blocks until approved)
  ├── Terminates TLS with generated domain cert
  ├── Scans decrypted traffic for ax-cred: placeholders
  ├── Replaces placeholders with real credential values
  └── Forwards to real server via upstream TLS
```

**Two proxy instances in k8s:**
- **Shared proxy** (`server-k8s.ts`): Listens on port 3128 via `ax-web-proxy` Service. Uses `SharedCredentialRegistry`. Session ID = `host-process`.
- **Per-session proxy** (`server-completions.ts`): For Docker/Apple sandboxes (Unix socket). Uses per-session `CredentialPlaceholderMap`.

## Key Files

| File | Role |
|------|------|
| `src/host/web-proxy.ts` | Proxy server: HTTP forward, CONNECT tunnel, MITM TLS interception |
| `src/host/credential-placeholders.ts` | `CredentialPlaceholderMap` (per-session) and `SharedCredentialRegistry` (k8s) |
| `src/host/web-proxy-approvals.ts` | Domain approval: `requestApproval()`, `preApproveDomain()`, caches |
| `src/host/proxy-ca.ts` | CA key generation, domain cert signing |
| `src/host/server-k8s.ts:118-156` | Shared proxy startup for k8s |
| `src/host/server-completions.ts:563-642` | Per-session proxy startup, credential registration |
| `src/agent/local-sandbox.ts` | `extractNetworkDomains()` — domain extraction for pre-approval |
| `src/agent/runner.ts:555-582` | CA cert writing, `CURL_CA_BUNDLE`/`SSL_CERT_FILE` setup |
| `src/agent/runners/pi-session.ts:355-392` | `HTTP_PROXY`/`HTTPS_PROXY` env var setup |

## Credential Replacement Flow

```
1. Host registers credential: credentialMap.register("LINEAR_API_KEY", realValue)
   → Returns placeholder: "ax-cred:38e10b8b39a945d1623937f77105e0ff"

2. Host registers map in SharedCredentialRegistry (by reference)
   → sharedCredentialRegistry.register(sessionId, credentialMap)

3. Placeholder sent to agent in NATS payload as credentialEnv
   → Agent sets process.env.LINEAR_API_KEY = "ax-cred:38e10b8b..."

4. Agent bash tool runs: curl -H "Authorization: $LINEAR_API_KEY" https://api.example.com
   → curl sends via HTTPS_PROXY → proxy receives CONNECT

5. Proxy MITM decrypts TLS, sees "Authorization: ax-cred:38e10b8b..."
   → SharedCredentialRegistry.replaceAllBuffer() replaces with real value
   → Forwards to real server with real credential
```

**Critical:** The `credentialMap` is registered in the `SharedCredentialRegistry` BY REFERENCE before credentials are populated. Later `credentialMap.register()` calls are immediately visible to the proxy.

**Critical:** `sharedCredentialRegistry.deregister(sessionId)` runs at session cleanup. If the session ends before the proxy processes the request, replacement fails silently (`hasPlaceholders: false`).

## Domain Approval — The Deadlock Problem

The proxy blocks CONNECT requests until the domain is approved. In k8s, the shared proxy uses `requestApproval('host-process', domain, ...)` which waits for a `proxy.approval` event (120s timeout).

### How Deadlock Happens

```
1. LLM generates tool calls: [web_approve("api.example.com"), bash("curl https://api.example.com")]
2. Tools execute sequentially: web_approve runs first (IPC → preApproveDomain)
3. bash runs curl → curl sends CONNECT to proxy
4. Proxy checks isDomainApproved('host-process', 'api.example.com') → true (pre-approved)
5. ✅ Works — approval happened before CONNECT
```

**Deadlock scenario (before the fix):**

```
1. bash("curl https://api.example.com") runs
2. sandbox_approve IPC fires with command, but extractNetworkDomains() returns [] (can't parse URL)
3. No pre-approval happens
4. curl sends CONNECT → proxy blocks waiting for approval
5. Agent is blocked on bash → can't send web_proxy_approve
6. 💀 Deadlock: proxy waits for agent, agent waits for proxy
7. After 120s: approval_timeout → proxy denies → curl fails
```

### Prevention: extractNetworkDomains()

The `sandbox_approve` IPC handler calls `preApproveDomain('host-process', domain)` for domains found in the bash command. The `extractNetworkDomains()` function in `local-sandbox.ts` extracts domains from:

1. **Package manager patterns** (`npm install` → `registry.npmjs.org`)
2. **URL domains in curl/wget/git commands** — uses `ANY_URL_PATTERN` to find all `https://` URLs
3. **Script file content** — if command runs a `.sh` file, reads it and extracts URLs

### Common extractNetworkDomains Pitfalls

| Command | Pitfall | Solution |
|---------|---------|----------|
| `curl -X POST "https://api.example.com"` | Quoted URLs were missed by old strict regex | Use `ANY_URL_PATTERN` on whole command when `curl`/`wget`/`git clone` detected |
| `node -e "fetch('https://...')"` | Node.js commands aren't curl/wget | Domains won't be extracted — Node fetch doesn't use proxy anyway (see below) |
| `./script.sh` | Domains only in script body | `extractDomainsFromScript()` reads `.sh` files and scans content |
| `python script.py` | Non-.sh scripts not scanned | Only `.sh` files are read — extend if needed |

## Node.js fetch Does NOT Use HTTP_PROXY

**This is a critical gotcha.** Node.js built-in `fetch` (undici-based) does NOT respect `HTTP_PROXY`/`HTTPS_PROXY` environment variables. This means:

- `curl` through the proxy: **works** (curl respects env vars)
- `wget` through the proxy: **works**
- `node -e "fetch(...)"`: **does NOT go through proxy** — tries direct connection, blocked by NetworkPolicy
- Linear SDK, npm packages using `fetch`: **does NOT go through proxy**

Node.js 22+ has `--use-env-proxy` flag, but it must be set before the process starts (via `NODE_OPTIONS`). This is not currently wired up.

**Impact:** Skills that use Node.js SDKs (e.g., `@linear/sdk`) for API calls will fail in k8s sandboxes. Curl-based API calls work correctly.

## CA Certificate Trust

The MITM proxy generates domain certs signed by its own CA. Sandbox processes must trust this CA.

### How it works

1. Host generates CA in `agentDir/ca/` via `getOrCreateCA()`
2. CA cert PEM sent to agent in NATS payload as `caCert`
3. Agent writes to `/tmp/ax-mitm-ca.pem` (Node.js `NODE_EXTRA_CA_CERTS`)
4. Agent builds combined bundle: system CAs + MITM CA → `/tmp/ax-ca-bundle.pem`
5. Sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` to combined bundle

### Common SSL Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl exit 60` (SSL cert problem) | MITM CA not in curl's trust store | Verify `CURL_CA_BUNDLE` points to combined bundle, not just the MITM CA |
| `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` pointing to same file | `NODE_EXTRA_CA_CERTS` is additive but `SSL_CERT_FILE` replaces the system bundle | Use separate files: MITM-only for Node, combined for curl |
| CA cert not written | `payload.caCert` is empty | Check `config.web_proxy` is true (defaults to true for k8s sandbox) |
| Wrong CA (shared vs per-session) | Both use same `agentDir/ca/` | `getOrCreateCA()` creates once, reuses — they share the same CA |

## K8s NetworkPolicy

Sandbox pods (`ax.io/plane: execution`) need egress to the proxy:

| Policy | Allows |
|--------|--------|
| `ax-sandbox-egress` | Port 3128 (proxy), 8080 (IPC), 4222 (NATS), 53 (DNS) to host/NATS pods |
| `ax-sandbox-restrict` | Port 8080, 4222, 53 (but NOT 3128) |

Both policies apply (k8s NetworkPolicies are additive). Port 3128 is allowed via `ax-sandbox-egress` (created when `webProxy.enabled` AND `networkPolicies.enabled` in Helm values).

**No direct port 443 egress** for execution-plane pods — all HTTPS must go through the proxy.

## Unhandled Socket Errors

The proxy's MITM path wraps `clientSocket` in a `tls.TLSSocket`. If the raw socket emits an error (e.g., `ECONNRESET` when curl times out), and no error handler is registered on the raw socket, the Node.js process crashes.

**Always add:** `clientSocket.on('error', () => {})` before wrapping in TLS.

This applies to both the MITM path and the URL-rewrite path in `web-proxy.ts`.

## Debugging Checklist

When proxy/credential issues arise, check in this order:

1. **Is the proxy running?** Look for `web_proxy_started` in host logs
2. **Is `config.web_proxy` true?** Defaults to true for k8s/docker/apple sandboxes
3. **Is `AX_WEB_PROXY_URL` in the payload?** Check `deps.extraSandboxEnv` in `server-k8s.ts`
4. **Are credentials registered?** Look for `credential_injected` in host logs
5. **Is the domain pre-approved?** Look for `approval_resolved` or `domain_preapproved` BEFORE `web_proxy_approval_required`
6. **Did CONNECT reach the proxy?** Look for `connect_mode` / `mitm_connect_start` (debug level)
7. **Did replacement happen?** Look for `mitm_credential_replaced` (success) or `mitm_placeholder_not_replaced` (failure with `hasPlaceholders: false`)
8. **Is the session still active?** If `session_completed` logged before the proxy request, credentials are deregistered

### Quick Test Without Agent

Create a test pod with `ax.io/plane: execution` label, copy the MITM CA cert from the host pod, set `HTTPS_PROXY` and `CURL_CA_BUNDLE`, and run curl. This isolates proxy issues from agent/LLM behavior. Pre-approve the domain first (e.g., via a quick agent session that calls `web_approve`).

## Gotchas Summary

- **`extractNetworkDomains` must handle complex curl flags** — don't assume URL is the first positional arg after `curl`. Use `ANY_URL_PATTERN` to find all URLs when curl/wget/git is detected.
- **Node.js `fetch` ignores `HTTP_PROXY`** — only curl/wget/pip respect proxy env vars.
- **`SharedCredentialRegistry` is session-scoped** — credentials vanish after `session_completed`.
- **Shared proxy approval uses `host-process` scope** — pre-approval must target this scope, not just the session scope.
- **Always handle socket errors** in proxy code — unhandled `ECONNRESET` crashes the host process.
- **k8s clusters without host volume mounts** need Docker image rebuild + `kind load` to deploy code changes. `npm run k8s:dev cycle` is a no-op without mounts.
