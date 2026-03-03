# Improving the First-Time Setup Experience

## Current State

The onboarding *infrastructure* is solid — there's an interactive wizard (`ax configure`), profile-based defaults, credential handling, and auto-trigger on first `ax serve`. But the *experience* has sharp edges that would trip up someone trying to get AX running for the first time.

Here's what a new user encounters today:

1. Website says `npx ax init` — **that command doesn't exist**
2. README says `npm start` — works, but the wizard output is plain and gives no indication of what to do next
3. After configure finishes: `Config written to ~/.ax/ax.yaml` — then silence. User stares at a running server with no idea how to talk to it
4. Need to open a *second terminal* and run `ax chat` — but nobody told them that
5. No validation that the API key actually works before the server starts accepting messages
6. Generic error if API key is wrong — diagnosed at LLM call time, not startup
7. Welcome banner is four lines of plain text with no personality (where's the crab?)

## Proposed Changes (Priority Order)

### 1. Post-Setup "What's Next" Banner (HIGH — biggest impact, smallest effort)

**File:** `src/onboarding/configure.ts`

After writing config, show a clear next-steps banner:

```
  ✓ Config written to ~/.ax/ax.yaml
  ✓ API key written to ~/.ax/.env

  ┌─────────────────────────────────────────────┐
  │  What's next:                               │
  │                                             │
  │  1. ax serve     Start the server           │
  │  2. ax chat      Chat with your agent       │
  │                                             │
  │  Or just run `ax serve` — it's already      │
  │  starting if this was your first run.       │
  └─────────────────────────────────────────────┘
```

When triggered from first-run auto-setup (inside `runServe`), show a different message:

```
  Server is running! Open a new terminal and run:

    ax chat
```

### 2. Startup Banner for `ax serve` (HIGH)

**File:** `src/cli/index.ts` (after `server.start()`)

When the server starts, print a clear status banner showing:
- What socket/port it's listening on
- How to connect (`ax chat` or `ax send`)
- Where logs are going
- How to stop it (`Ctrl+C`)

Something like:

```
  🦀 AX is running

  Socket: ~/.ax/ax.sock
  Logs:   ~/.ax/data/ax.log
  Profile: balanced

  → Open a new terminal and run: ax chat
  → Press Ctrl+C to stop
```

### 3. API Key Pre-Flight Check (HIGH)

**File:** `src/cli/index.ts` or new `src/cli/preflight.ts`

Before starting the server, do a minimal validation:
- Check that the credential provider can resolve an API key (non-empty)
- Optionally: make a tiny API call (list models or a 1-token completion) to verify the key works
- If it fails, show a clear message: "Your API key doesn't seem to work. Run `ax configure` to update it."

This catches the #1 first-time failure mode: typo in the API key, or forgetting to set it entirely.

### 4. Better Welcome Banner (MEDIUM)

**File:** `src/onboarding/prompts.ts`

The current `ASCII_WELCOME` is:
```
   Welcome to Project AX!

   The security-first personal AI agent.
   Let's get you set up.
```

It should have more personality (per the voice guidelines) and set expectations:

```
   🦀 Welcome to AX

   Security-first personal AI agent.
   We're about to ask you a few questions — nothing scary.

   (Takes about 30 seconds. We timed it.)
```

### 5. `ax init` Command Alias (MEDIUM — fixes broken website promise)

**File:** `src/cli/index.ts`

The website hero CTA says `npx ax init`. We should either:
- **(a)** Add `init` as an alias for `configure` in the command router
- **(b)** Update the website to say `ax configure`

Option (a) is better — `init` is what people expect from a CLI tool, and it's a one-line change to the router.

### 6. Smarter `ax chat` When Server Isn't Running (MEDIUM)

**File:** `src/cli/chat.ts`

Currently if you run `ax chat` without `ax serve`, you get `ECONNREFUSED`. Instead:
- Detect the missing server
- Show: "AX server isn't running. Start it first with: `ax serve`"
- Or even better: offer to auto-start the server in the background

### 7. Config Validation Error Messages (LOW)

**File:** `src/config.ts`

When `ax.yaml` has a validation error, the Zod error message is raw and technical. Wrap it with a user-friendly message that:
- Says which field is wrong
- Shows the valid options
- Points to `ax configure` as the fix

### 8. `ax doctor` Command (LOW — nice-to-have)

**Files:** `src/cli/index.ts`, new `src/cli/doctor.ts`

A diagnostic command that checks:
- Node.js version
- Config file exists and is valid
- API key is set and works
- Socket file is writable
- Sandbox backend is available
- Required dependencies are installed

Prints a checklist with ✓/✗ for each item. Useful for debugging and support.

## What NOT to Change

- The wizard flow itself is good — profile → agent → auth → model → channels is logical
- The profile defaults are sensible
- The reconfigure flow (pre-filling from existing config) works well
- Hot-reload is a nice feature, don't touch it

## Implementation Order

If we're doing this in one pass:

1. **Welcome banner** (prompts.ts) — 5 min
2. **Post-setup next steps** (configure.ts) — 15 min
3. **Startup banner** (cli/index.ts) — 15 min
4. **`init` alias** (cli/index.ts) — 5 min
5. **API key pre-flight** (cli/index.ts or preflight.ts) — 30 min
6. **Smarter `ax chat` error** (cli/chat.ts) — 15 min
7. **Tests for all the above** — 30 min

Items 7 and 8 from the list above (config validation messages and `ax doctor`) are good follow-ups but not critical for the first-time experience.
