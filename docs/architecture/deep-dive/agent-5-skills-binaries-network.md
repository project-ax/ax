# Agent 5 Report — Skill Binaries, Install Execution, and Network/Proxy Paths

## 1) Skill dependency model

Skills can declare install steps in metadata with `run`, optional `bin`, optional `os` filters.

Install is exposed as a two-phase IPC action:

- `skill_install` phase `inspect`
- `skill_install` phase `execute` (single step)

This keeps user approval and execution separate.

## 2) Inspect phase (no arbitrary command execution)

During inspect, host:

- reads/parses skill
- filters install steps by OS
- validates command format/prefix
- checks binaries with safe PATH lookup (`binExists`)
- returns status and `inspectToken` (hash of inspected steps)

`inspectToken` is TOCTOU protection: execute must match inspected content.

## 3) Execute phase

When execute is called, host:

- re-parses skill and recomputes inspect token
- rejects token mismatch
- re-validates command safety
- enforces per-agent install semaphore
- runs the command asynchronously (`execFile` via shell)
- records output, exit code, and persisted install state
- writes audit events for inspect/execute/step outcomes

## 4) Where binaries are installed and run

Current implementation runs skill install commands in the **host process context** (trusted plane), not inside sandbox pods/containers.

Consequences:

- installed binaries land in host-visible locations (depending on package manager)
- installs have host network reachability unless host policy/firewall says otherwise
- security relies on allowlist + approval + audit + env scrubbing controls

## 5) How binaries get internet access today

### What exists now

- install commands run on host and can use host egress directly
- command prefixes are restricted to known package managers

### Important caveat: host HTTP proxy variables are scrubbed

The install environment is intentionally minimized by `buildScrubbedEnv()` and currently includes `PATH`, `HOME`, `USER`, `TMPDIR`, `LANG`, `SHELL` (+ optional Node/Homebrew path vars), but **not** `HTTP_PROXY`/`HTTPS_PROXY`.

So, strictly speaking, AX currently does **not** provide a dedicated “internet via host HTTP proxy” path for skill install commands out of the box.

## 6) Practical interpretation for operators

- If host has direct outbound internet, install steps can fetch packages directly.
- If your environment requires explicit HTTP(S) proxy env vars, current scrubbed env behavior can block install networking.
- Supporting proxy-required environments would require a deliberate change to propagate vetted proxy vars in `buildScrubbedEnv()`.

## 7) Relationship to LLM proxying

Do not confuse two different proxies:

1. **LLM credential proxy** (`host/proxy.ts`, `nats-llm-proxy.ts`) — for Anthropic/API credential isolation.
2. **Skill install package download path** — host command execution environment for package managers.

Only #1 is implemented as an AX-managed proxy mechanism today.
