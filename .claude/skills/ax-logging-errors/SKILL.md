---
name: ax-logging-errors
description: Use when modifying logging, error handling, or diagnostic messages — logger setup, transports, error diagnosis patterns in src/logger.ts and src/errors.ts
---

## Overview

AX uses a custom structured logger with dual transports (console + file) and an error diagnosis system that maps common failure patterns to human-readable suggestions. The logger is a singleton initialized once at startup.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/logger.ts` | Structured logger with console + file transports | `initLogger()`, `getLogger()`, `Logger`, `LogLevel` |
| `src/errors.ts` | Error pattern matching and user-facing diagnosis | `diagnoseError()`, `formatDiagnosedError()`, `DiagnosedError` |

## Logger

### Initialization

```typescript
initLogger({ level?: LogLevel, pretty?: boolean });
```

- **level**: `'debug' | 'info' | 'warn' | 'error' | 'fatal'` (default: `'info'`, overrideable via `LOG_LEVEL` env)
- **pretty**: Color-coded compact output if `true` (default: auto-detect TTY)
- **AX_VERBOSE**: Set `AX_VERBOSE=1` to enable verbose (debug-level) logging. This is the unified verbose flag — replaces various per-component debug flags. Used in `src/cli/index.ts` to set log level to debug at startup.

### Transports

1. **Console** -- Level-configurable, pretty or JSON format
2. **File** -- Always debug level, JSONL format to `~/.ax/data/ax.log`

### Usage

```typescript
const log = getLogger();
log.info('server_listening', { port: 3000 });
const reqLog = log.child({ reqId: 'abc-123' });
```

## Error Diagnosis

### DiagnosedError

```typescript
interface DiagnosedError {
  raw: string;         // Original error message
  diagnosis: string;   // Human-readable explanation
  suggestion: string;  // Actionable fix
  logHint: string;     // Path to ax.log for details
}
```

### Patterns

| Pattern | Diagnosis | Suggestion |
|---|---|---|
| `ETIMEDOUT` | Network timeout | Check connectivity / proxy settings |
| `ECONNREFUSED` | Connection refused | Check if service is running |
| `ECONNRESET` | Connection reset | Retry or check network stability |
| `ENOTFOUND` | DNS lookup failed | Check URL / network config |
| `EPERM` | Permission denied (agent spawn/kill) | Check sandbox config, tsx wrapper |
| `401` | Authentication failed | Check API key / OAuth token |
| `403` | Forbidden | Check permissions / API access |
| `429` | Rate limited | Reduce request frequency |
| `50x` | Server error | Retry later |
| `CERT/SSL/TLS` | TLS handshake failed | Check certificates / proxy config |
| (fallback) | Unexpected error | See log file for details |

**Agent spawn errors**: Improved diagnosis for process signal handling (SIGKILL, SIGTERM) and EPERM errors from tsx-wrapped agents. `formatDiagnosedError()` produces user-facing strings with diagnosis, suggestion, and log path.

## Common Tasks

**Adding a new error pattern:**
1. Add regex + diagnosis + suggestion entry to the patterns array in `errors.ts`
2. Add test in `tests/errors.test.ts`

## Gotchas

- **Underscore keys in log messages**: Use `'server_listening'` not `'server listening'`.
- **File transport is always debug**: Even if console level is `'error'`.
- **`getLogger()` before `initLogger()` returns a no-op**: Always call `initLogger()` at startup.
- **Error diagnosis is best-effort**: Unknown errors get a generic fallback.
- **Don't use `console.log` directly**: Always use the logger for structured output.
- **EPERM on agent kill**: tsx-wrapped agents may throw EPERM when receiving signals. The error handler wraps kill in try/catch.
- **Read-only filesystem handling**: The logger gracefully skips the file transport when the filesystem is read-only (e.g., container environments). No crash on write failure — it silently falls back to console-only logging.
