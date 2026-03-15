# Agent 1 Report — Core Runtime Architecture (Host Plane)

## 1) Control plane shape

AX uses a trusted **host process** as the orchestration and policy boundary:

- boots providers through a static provider map
- receives inbound requests in server handlers
- applies routing + taint budget
- mediates all sensitive capability calls through IPC handlers

This keeps policy and credentials outside sandbox execution paths.

## 2) Provider contract model

The host constructs a provider registry and loads implementations by name from a static allowlist map (no dynamic user-controlled import path construction).

Practical implications:

- each provider exports a `create(config)` factory
- security policy can be enforced at registration points
- tests can mock provider interfaces at category boundaries

## 3) Completion request lifecycle (high-level)

1. Channel/server endpoint receives user content.
2. Host resolves session, memory/history, and policy state.
3. Host prepares sandbox + agent runner bootstrap payload.
4. Agent sends tool/LLM actions back to host over IPC.
5. Host handlers execute trusted actions and stream results.

## 4) IPC server and handler dispatch

IPC actions are strongly schema-gated (Zod strict object schemas) and then dispatched into handler modules (LLM, memory, workspace, skills, scheduler, plugin, image, sandbox tools, etc.).

Why this matters:

- unknown fields are rejected early
- action-specific policy can be centralized
- audit logging becomes deterministic per action

## 5) Security-critical host responsibilities

- credential custody (API keys and OAuth tokens stay on host)
- taint accounting for untrusted content
- audit log writes for sensitive actions
- workspace commit pipeline enforcement through workspace provider + scanner

## 6) Why this architecture scales

The same host policy layer can drive:

- local single-process deployments
- lazy containerized sandbox flows
- k8s split-plane deployments (host + runtime + sandbox workers)

without changing the trust model: untrusted execution is always mediated by host-owned providers.
