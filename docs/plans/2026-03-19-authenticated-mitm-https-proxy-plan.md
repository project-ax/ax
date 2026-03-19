# Authenticated MITM HTTPS Proxy Plan

**Date:** 2026-03-19
**Status:** Proposed
**Builds on:** [2026-03-16 HTTP Forward Proxy for Sandboxed Agents](./2026-03-16-http-proxy-design.md), [2026-02-10 Credential-Injecting Proxy Implementation Plan](./2026-02-10-credential-injecting-proxy.md), [2026-02-26 Plugin Framework Design](./2026-02-26-plugin-framework-design.md)

## Summary

AX should extend the existing host web proxy into an **authenticated HTTPS broker**
with two explicit modes:

1. **Authenticated tunnel mode** for generic outbound CLI traffic.
2. **Authenticated MITM mode** for approved services that need host-side
   credential injection.

The proxy must be **session-aware and turn-aware**. A sandbox request must arrive
with short-lived proxy credentials that bind the request to a specific AX turn,
just like `AX_IPC_TOKEN` binds IPC calls today. This is the key difference
between a secure credential broker and a transparent shared network utility.

This plan keeps the raw upstream API key out of the sandbox while still being
general enough to support the long tail of CLI tools that only know how to use
`HTTP_PROXY` / `HTTPS_PROXY`.

## Problem

Many imported skills and CLI tools expect to authenticate by putting a real API
key in the process environment before the tool starts. That conflicts directly
with AX's current sandbox invariant: credentials must not enter the sandbox.

Explicit service-specific routes such as `/internal/llm-proxy` remain the
safest pattern for first-party, well-understood integrations, but they do not
cover the long tail of arbitrary CLI tools that speak generic HTTP(S) through
standard proxy environment variables.

The current AX web proxy is close, but it is not sufficient:

- It is a standard forward proxy and CONNECT tunnel. It does not inspect HTTPS
  today.
- In k8s it runs as a shared service and loses per-session identity, falling
  back to a global approval scope (`host-process`).
- It can govern network access, but it cannot inject service credentials into
  opaque HTTPS traffic.

## Goals

1. Keep upstream API credentials out of sandbox environments and filesystems.
2. Support unmodified or lightly wrapped CLI tools that respect
   `HTTP_PROXY` / `HTTPS_PROXY`.
3. Preserve per-turn identity and auditability for every proxied request.
4. Keep MITM narrow, explicit, and policy-driven rather than global.
5. Preserve the existing explicit `/internal/*` proxies for high-value services.
6. Work across Docker, Apple, k8s, and subprocess sandboxes with one logical
   model.

## Non-Goals

1. Replacing `/internal/llm-proxy` or other explicit first-party proxies.
2. Supporting arbitrary non-HTTP protocols.
3. Supporting every certificate-pinned client with credential injection.
4. Making a transparent, unauthenticated, cluster-wide MITM proxy the default.

## Recommendation

Adopt a **hybrid proxy architecture**:

- **Authenticated tunnel mode** is the default for generic outbound HTTP/HTTPS.
  The proxy authenticates the sandbox, applies domain/IP policy, audits the
  request, and either forwards plain HTTP or tunnels HTTPS via CONNECT.
- **Authenticated MITM mode** is enabled only for explicitly configured
  **service bindings**. The proxy terminates TLS, validates the upstream
  certificate, injects host-held credentials, enforces method/path policy, and
  re-encrypts traffic with an AX-managed CA certificate trusted by the sandbox.

This yields one general mechanism for the long tail of CLIs while keeping the
dangerous part of MITM limited to known service profiles.

## Security Model

### New Trust Statement

If this plan ships, AX's effective trust model becomes:

- Sandboxes do **not** receive raw service credentials.
- Sandboxes **do** trust an AX-managed proxy CA for approved outbound HTTPS.
- The host proxy becomes a trusted credential broker for approved services.

That is a real expansion of trust compared to today's plain CONNECT web proxy,
so the implementation must make the boundary explicit and easy to audit.

### Invariants

1. **Proxy authentication is mandatory.** No anonymous sandbox traffic reaches
   the host proxy.
2. **Credentials are injected only for bound services.** Never for arbitrary
   hosts.
3. **MITM is opt-in per service binding.** Tunnel mode remains available.
4. **Path and method allowlists apply in MITM mode.**
5. **Audit logs include session and request identity.**
6. **All sensitive injected headers are redacted in logs and events.**
7. **Pinned or incompatible clients can use explicit tunnel/bypass rules, but
   they lose injection and deep visibility.**

## Why This Scales

The scalable unit is not "one route per skill." The scalable unit is:

- one **shared authenticated proxy runtime**
- plus many **service bindings**

Multiple skills can reuse the same binding:

- `linear` binding for multiple Linear-related skills
- `github` binding for multiple GitHub automation skills
- `jira` binding for multiple issue-management skills

This keeps the host-side implementation bounded while still supporting the long
tail of clients that only understand proxy env vars.

## Architecture

### 1. Authenticated Proxy Identity

Introduce a short-lived **proxy token** distinct from the raw upstream
credential.

Each turn gets:

- `AX_IPC_TOKEN` for IPC
- `AX_PROXY_TOKEN` for outbound HTTP/HTTPS proxy auth

The host stores proxy token metadata alongside the active request context:

```ts
interface ActiveProxyContext {
  sessionId: string;
  requestId: string;
  userId?: string;
  agentId?: string;
  canaryToken?: string;
  approvedServices: string[];
  allowHosts: string[];
}
```

### 2. Local Bridge in Every Sandbox

For consistency and better identity handling, AX should run a small local proxy
bridge inside every sandbox type, not just Docker/Apple.

The CLI tool sees:

```bash
HTTP_PROXY=http://127.0.0.1:<local-port>
HTTPS_PROXY=http://127.0.0.1:<local-port>
```

The local bridge adds proxy authentication on outbound requests to the host
proxy using `AX_PROXY_TOKEN`. This gives AX:

- one auth mechanism across all sandbox providers
- no need to expose proxy credentials in user-facing env vars
- a single place to normalize proxy behavior for tools

### 3. Two Host Proxy Modes

| Mode | Use Case | TLS | Credential Injection |
|------|----------|-----|----------------------|
| `tunnel` | Generic CLI traffic, package installs, git clone | CONNECT passthrough | No |
| `mitm` | Approved service binding, auth injection required | Host terminates + re-encrypts | Yes |

Tunnel mode remains the default. MITM is only selected when the target host
matches a service binding with `mode: mitm`.

### 4. Service Bindings

Add a host-side service binding registry that maps target hosts to:

- credential keys
- injection strategy
- allowed methods
- allowed paths
- logging redaction policy
- whether MITM is required

Example:

```yaml
proxy:
  policy: deny
  services:
    linear:
      hosts:
        - api.linear.app:443
      mode: mitm
      credentials:
        - LINEAR_API_KEY
      inject:
        type: header
        name: Authorization
        format: "Bearer ${LINEAR_API_KEY}"
      allow:
        methods: [POST]
        paths: [/graphql]
      redact:
        headers: [authorization]
```

This is intentionally service-centric, not skill-centric.

### 5. CA Management

MITM mode requires an AX-managed CA pair:

- private key: host only
- public cert: distributed to sandboxes

The public cert is not secret, but it is security-critical. AX should:

1. Generate a stable CA in AX data/config storage on first startup.
2. Expose the public cert to runners via mounted file or payload.
3. Export common trust env vars in sandbox runners:
   - `NODE_EXTRA_CA_CERTS`
   - `SSL_CERT_FILE`
   - `REQUESTS_CA_BUNDLE`
   - `CURL_CA_BUNDLE`
   - `GIT_SSL_CAINFO`
   - `npm_config_cafile`
4. Keep explicit tunnel/bypass rules for clients that still reject the CA.

For the true long tail, AX may eventually need to bake trust-store updates into
its base images. The env-var approach is the right first step because it is
reversible and easier to roll out safely.

### 6. Keep Explicit `/internal/*` Proxies

Do not migrate everything into MITM.

Keep:

- `/internal/llm-proxy`
- future explicit first-party proxies when a service deserves a purpose-built
  contract

MITM is the general escape hatch for opaque CLI tools, not the new default
integration pattern for every service.

## File-Level Plan

### Phase 1: Session-Aware Authenticated Proxy Plumbing

**Goal:** Fix identity first, before adding MITM.

**Core changes**

- Extend host request context with `AX_PROXY_TOKEN`.
- Add proxy-token registry to the host alongside `activeTokens`.
- Update stdin payload + warm-pod payload flow to carry proxy token data.
- Start a local bridge in all sandbox modes.
- Require host proxy authentication for all requests.

**Likely files**

- `src/host/host-process.ts`
- `src/host/server-completions.ts`
- `src/host/web-proxy.ts`
- `src/agent/runner.ts`
- `src/agent/runners/pi-session.ts`
- `src/agent/runners/claude-code.ts`
- `src/agent/web-proxy-bridge.ts`
- `src/providers/sandbox/canonical-paths.ts`
- `src/providers/sandbox/k8s.ts`

**Behavior**

- Invalid or missing proxy auth returns `407 Proxy Authentication Required`.
- Audit logs use real `sessionId` / `requestId`, not the global `host-process`
  placeholder.
- Proxy remains tunnel-only in this phase.

### Phase 2: CA Management + MITM Infrastructure

**Goal:** Add the technical substrate for HTTPS inspection without turning it on
for arbitrary hosts.

**Core changes**

- Add CA generation/load helpers.
- Add certificate issuance for target hosts.
- Teach runners/bridges to expose CA trust to common clients.
- Add MITM server path for CONNECT requests that match `mode: mitm`.

**Likely files**

- `src/host/web-proxy.ts`
- `src/host/proxy-ca.ts` (new)
- `src/host/proxy-cert-cache.ts` (new)
- `src/agent/web-proxy-bridge.ts`
- `src/agent/runner.ts`

**Behavior**

- Tunnel remains default.
- MITM path exists behind explicit service binding.

### Phase 3: Service Bindings + Credential Injection

**Goal:** Make credential injection declarative and bounded.

**Core changes**

- Add config schema for service bindings.
- Resolve credentials through the credential provider at request time.
- Support bounded injection strategies:
  - static header
  - bearer token header
  - API key header
  - optional query param for legacy services
- Enforce method/path allowlists in MITM mode.
- Redact injected headers from logs.

**Likely files**

- `src/config.ts`
- `src/host/web-proxy.ts`
- `src/host/proxy-service-bindings.ts` (new)
- `src/providers/credentials/types.ts`
- `tests/host/web-proxy.test.ts`

**Behavior**

- MITM traffic without a matching binding is rejected or falls back to tunnel,
  depending on policy.
- Bound services can inject credentials without ever exposing them to the
  sandbox.

### Phase 4: Long-Tail Tooling UX

**Goal:** Make the system usable for skills and operators.

**Core changes**

- Add service-binding docs and examples for common APIs.
- Extend skill metadata over time to prefer `requires.services` in addition to
  raw `requires.env`.
- Surface warnings when a skill requires a known service binding that is absent.

**Likely files**

- `src/providers/skills/types.ts`
- `src/utils/skill-format-parser.ts`
- `src/utils/manifest-generator.ts`
- `src/agent/prompt/modules/skills.ts`
- docs under `docs/plans/` or README

**Behavior**

- Skills become less coupled to raw env vars.
- Operators configure services once; many skills reuse them.

## Policy Model

### Recommended Defaults

- Global outbound proxy policy: `deny`
- Package-manager allowlist: explicit tunnel mode
- MITM bindings: explicit per service
- Private IP / SSRF blocking: always on
- Bypass/pinning exceptions: explicit and narrow

### Request Matching Order

1. Authenticate proxy request
2. Resolve session/request context
3. Match host against service bindings
4. Apply SSRF / CIDR checks
5. Select mode:
   - explicit `mitm`
   - explicit `tunnel`
   - explicit `bypass`
   - reject
6. Audit decision and outcome

## Testing Plan

### Unit Tests

- Proxy auth success/failure
- Token-to-session binding
- Service binding matching
- Header injection and redaction
- Method/path allowlist enforcement
- CA load/generation behavior

### Integration Tests

- Docker sandbox: `curl`, `npm`, `git`, Node `fetch`, Python `requests`
- k8s sandbox: same set through shared host service
- Warm-pod flow: proxy token in stdin payload and `applyPayload()`
- Invalid token cross-session attempt is rejected
- MITM bound host injects auth
- Tunnel-only host does not inject auth
- Pinned/bypassed host succeeds without injection

### Security Tests

- Private-IP SSRF blocking still works in tunnel and MITM modes
- CONNECT target host mismatch / domain-fronting rejection
- Redaction of auth headers in logs and events
- Replay of expired proxy token rejected
- Missing session binding never collapses to a global approval scope

## Rollout Strategy

### Stage A: Authenticated Tunnel Only

Ship proxy authentication and session-aware logging first with no MITM
inspection. This removes the current k8s identity gap and de-risks the biggest
architectural flaw in the present proxy.

### Stage B: One Internal Test Binding

Enable MITM for a single canary binding in dev/test only. Verify:

- CA trust behavior
- injection correctness
- audit semantics
- compatibility with representative clients

### Stage C: Small Set of Official Bindings

Add a few well-understood service profiles with strict policies:

- `linear`
- `github`
- maybe `jira`

Do not open arbitrary custom bindings until the testing story is strong.

### Stage D: Skill-Aware Service Declarations

Once bindings are stable, extend the skill model so imported skills can declare
service dependencies rather than only raw env vars.

## Risks

1. **CA trust is broad.** A trusted MITM CA gives the host broad power. This is
   acceptable only with explicit policy and strong auditability.
2. **Not all tools honor proxy env vars consistently.** The local bridge reduces
   that pain, but some tools will still need bypass or wrappers.
3. **Pinned clients will fail in MITM mode.** This is expected and must be
   handled through narrow tunnel/bypass rules.
4. **Transparent shared proxies lose identity.** This is why Phase 1 is
   mandatory before any credential injection work.
5. **MITM can drift into a universal integration layer.** Resist that. Keep
   first-party/high-value services on explicit `/internal/*` routes when
   possible.

## Open Questions

1. Should `AX_PROXY_TOKEN` be separate from `AX_IPC_TOKEN`, or is a scoped
   derivative sufficient?
2. Which trust-store strategy works best across AX base images: env-var CA files
   only, or image-level CA installation?
3. Should custom service bindings be user-configurable immediately, or should AX
   ship only vetted built-in profiles first?
4. How much method/path policy should be declarative in config vs hard-coded in
   official profiles?

## Recommendation Recap

The best general solution is **not** "turn the current web proxy into a
transparent global MITM." The best general solution is:

- authenticated local bridge in every sandbox
- session-aware host proxy
- tunnel mode by default
- MITM only for explicit service bindings
- keep explicit `/internal/*` proxies for first-party integrations

That is the highest-security version of MITM that still supports the long tail
of real CLI tools.
