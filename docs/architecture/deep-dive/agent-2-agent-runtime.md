# Agent 2 Report — Agent Runtime, Prompt, and Tooling

## 1) Agent process responsibilities

The agent process is execution-focused:

- builds runtime prompt context
- runs selected runner (`pi-session` or `claude-code`)
- exposes local tools and IPC-backed tools
- streams outputs/events back to host

It does **not** own credentials, policy, or durable authority.

## 2) Runners

### `pi-session`

- can run LLM transport via host proxy socket when available
- falls back to IPC LLM path when proxy transport unavailable
- integrates modular prompt composition and local tool loop

### `claude-code`

- local mode: uses TCP bridge to Unix socket proxy
- k8s mode: uses NATS bridge and runtime-side LLM proxy
- requires proxy/NATS pathway; fails fast when neither is available

## 3) Prompt assembly model

Prompt modules in `src/agent/prompt/modules/` handle separable concerns:

- identity
- security
- delegation
- memory recall
- runtime constraints
- skills injection

This keeps policy text composable and testable.

## 4) Tool exposure model

Agent tools are a merged catalog of:

- local/sandbox tools (bash, file ops, etc. depending on sandbox path)
- host IPC tools (memory, skills, scheduler, workspace, etc.)

Tool availability is filtered by capability/profile/context checks.

## 5) Skills in agent runtime

The agent can:

- list/read skills
- import skills
- inspect/install skill dependencies via two-phase install protocol

Install execution still occurs in the host plane via IPC handlers.

## 6) Key boundary reminder

Even when a runner appears to call LLM APIs directly, credentials are injected by host-owned proxy pathways (Unix socket or runtime NATS proxy) so secrets remain outside the sandboxed agent runtime.
