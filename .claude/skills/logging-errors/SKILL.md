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
- **pretty**: Color-coded compact output if `true` (default: auto-detect TTY on stdout)

### Transports

1. **Console** — Level-configurable, pretty or JSON format
2. **File** — Always debug level, JSONL format to `~/.ax/data/ax.log` (AX_HOME/data/ax.log)

### Interface

```typescript
interface Logger {
  debug(msg: string, details?: Record<string, unknown>): void;
  info(msg: string, details?: Record<string, unknown>): void;
  warn(msg: string, details?: Record<string, unknown>): void;
  error(msg: string, details?: Record<string, unknown>): void;
  fatal(msg: string, details?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
```

### Usage Pattern

```typescript
import { getLogger } from './logger.js';
const log = getLogger();

log.info('server_listening', { port: 3000, socketPath: '/tmp/ax.sock' });
log.error('ipc_dispatch_failed', { action: 'llm_call', error: err.message });

// Child logger with bound context
const reqLog = log.child({ reqId: 'abc-123', sessionId: 'main:cli:default' });
reqLog.info('request_started');
```

### Pretty Format

When pretty mode is enabled, output is compact with color coding:
- Skips `level`, `time`, `pid`, `hostname`, `msg` from structured details
- Displays remaining details as `key=value` pairs
- Color-coded by level

## Error Diagnosis

### DiagnosedError Interface

```typescript
interface DiagnosedError {
  raw: string;         // Original error message
  diagnosis: string;   // Human-readable explanation
  suggestion: string;  // Actionable fix
  logHint: string;     // Path to ax.log for details
}
```

### Pattern Matching

`diagnoseError(err)` matches error messages against regex patterns:

| Pattern | Diagnosis | Suggestion |
|---|---|---|
| `ETIMEDOUT` | Network timeout | Check connectivity / proxy settings |
| `ECONNREFUSED` | Connection refused | Check if service is running |
| `ECONNRESET` | Connection reset | Retry or check network stability |
| `ENOTFOUND` | DNS lookup failed | Check URL / network config |
| `401` | Authentication failed | Check API key / OAuth token |
| `403` | Forbidden | Check permissions / API access |
| `429` | Rate limited | Reduce request frequency |
| `50x` | Server error | Retry later |
| `CERT/SSL/TLS` | TLS handshake failed | Check certificates / proxy config |
| (fallback) | Unexpected error | See log file for details |

### Usage

```typescript
import { diagnoseError, formatDiagnosedError } from './errors.js';

try {
  await apiCall();
} catch (err) {
  const diagnosed = diagnoseError(err);
  console.error(formatDiagnosedError(diagnosed));
}
```

`formatDiagnosedError()` produces a user-facing string with diagnosis, suggestion, and log file path.

## Common Tasks

**Adding a new error pattern:**
1. Add regex + diagnosis + suggestion entry to the patterns array in `errors.ts`
2. Add test in `tests/errors.test.ts`

**Changing log level at runtime:**
Use the `LOG_LEVEL` environment variable. The file transport always logs at debug level regardless.

**Adding structured context to logs:**
Use `log.child()` to create a logger with bound fields that appear in every subsequent log entry.

## Gotchas

- **Underscore keys in log messages**: Use `'server_listening'` not `'server listening'`. Tests matching log output depend on underscores.
- **File transport is always debug**: Even if console level is `'error'`, the file at `~/.ax/data/ax.log` captures everything at debug level.
- **`getLogger()` before `initLogger()` returns a no-op**: Always call `initLogger()` at startup before any logging.
- **Error diagnosis is best-effort**: It matches known patterns. Unknown errors get a generic fallback with a pointer to the log file.
- **Don't use `console.log` directly**: Always use the logger. Direct console output doesn't go to the file transport and breaks structured logging.
