---
name: ax-web-proxy
description: Use when debugging MITM proxy issues, credential placeholder replacement failures, domain allowlist problems, sandbox HTTPS connectivity problems, curl exit 60 SSL errors, ECONNRESET crashes in the proxy, or modifying web-proxy.ts / credential-placeholders.ts / proxy-domain-list.ts
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
  ├── Checks domain against ProxyDomainList (synchronous, no blocking)
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
| `src/host/proxy-domain-list.ts` | `ProxyDomainList` — domain allowlist from skill manifests + admin approvals |
| `src/host/credential-placeholders.ts` | `CredentialPlaceholderMap` (per-session) and `SharedCredentialRegistry` (k8s) |
| `src/host/proxy-ca.ts` | CA key generation, domain cert signing |
| `src/host/server-init.ts` | Creates `ProxyDomainList`, populates from installed skills at startup |
| `src/host/server-k8s.ts` | Shared proxy startup for k8s |
| `src/host/server-completions.ts` | Per-session proxy startup, credential registration |
| `src/host/ipc-handlers/skills.ts` | `skill_install` handler — adds domains to allowlist on install |
| `src/host/server-admin.ts` | Admin endpoints for domain management (GET/POST /admin/api/proxy/domains) |
| `src/agent/runner.ts` | CA cert writing, `CURL_CA_BUNDLE`/`SSL_CERT_FILE` setup |
| `src/agent/runners/pi-session.ts` | `HTTP_PROXY`/`HTTPS_PROXY` env var setup |

## Domain Allowlist

Domains are allowed if they appear in any of these sources:

1. **Built-in domains** — package manager registries (npmjs.org, pypi.org, etc.) and GitHub
2. **Skill-declared domains** — auto-extracted from skill body URLs via `generateManifest()` when skills are installed via `skill_install` IPC handler
3. **Admin-approved domains** — manually approved via `POST /admin/api/proxy/domains/approve`

Unknown domains are **denied immediately** (no blocking, no deadlock) and queued for admin review.

### How domains flow from skill install to proxy

```
1. Agent calls skill({ type: "install", query: "linear" })
2. Host downloads skill from ClawHub, parses SKILL.md
3. Host runs generateManifest() → extracts domains from URLs in skill body
4. Host calls domainList.addSkillDomains("linear", ["api.linear.app"])
5. Next proxy request to api.linear.app → allowed (in allowlist)
```

### Admin domain management

```
GET  /admin/api/proxy/domains         → { allowed: [...], pending: [...] }
POST /admin/api/proxy/domains/approve → { domain: "api.example.com" }
POST /admin/api/proxy/domains/deny    → { domain: "api.example.com" }
```

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

**Critical:** `sharedCredentialRegistry.deregister(sessionId)` runs at session cleanup. If the session ends before the proxy processes the request, replacement fails silently.

## Node.js fetch Does NOT Use HTTP_PROXY

Node.js built-in `fetch` (undici-based) does NOT respect `HTTP_PROXY`/`HTTPS_PROXY` environment variables:

- `curl` through the proxy: **works**
- `wget` through the proxy: **works**
- `node -e "fetch(...)"`: **does NOT go through proxy** — blocked by NetworkPolicy
- Node.js SDKs using `fetch`: **does NOT go through proxy**

Node.js 22+ has `--use-env-proxy` flag but it's not currently wired up.

## CA Certificate Trust

1. Host generates CA in `agentDir/ca/` via `getOrCreateCA()`
2. CA cert PEM sent to agent in NATS payload as `caCert`
3. Agent writes to `/tmp/ax-mitm-ca.pem` (Node.js `NODE_EXTRA_CA_CERTS`)
4. Agent builds combined bundle: system CAs + MITM CA → `/tmp/ax-ca-bundle.pem`
5. Sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` to combined bundle

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl exit 60` | MITM CA not in curl's trust store | Verify `CURL_CA_BUNDLE` points to combined bundle |
| CA cert not written | `payload.caCert` is empty | Check `config.web_proxy` is true |

## Debugging Checklist

1. **Is the proxy running?** Look for `web_proxy_started` in host logs
2. **Is `config.web_proxy` true?** Defaults to true for k8s/docker/apple sandboxes
3. **Is the domain in the allowlist?** Check `GET /admin/api/proxy/domains`
4. **Is the skill installed via `skill_install`?** Only host-installed skills add domains
5. **Are credentials registered?** Look for `credential_injected` in host logs
6. **Did replacement happen?** Check if `credentialMap` has placeholders for the session
7. **Is the session still active?** Credentials deregistered at `session_completed`

## Gotchas

- **Node.js `fetch` ignores `HTTP_PROXY`** — only curl/wget/pip respect proxy env vars
- **`SharedCredentialRegistry` is session-scoped** — credentials vanish after `session_completed`
- **Always handle socket errors** in proxy code — unhandled `ECONNRESET` crashes the host process. Add `clientSocket.on('error', ...)` before TLS wrapping.
- **Agent-authored skills don't get proxy access** — only skills installed via `skill_install` IPC handler add domains to the allowlist
- **k8s clusters without host volume mounts** need Docker image rebuild + `kind load` to deploy code changes
