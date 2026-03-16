/**
 * Regression tests — prevent recurrence of specific bugs fixed in recent commits.
 *
 * Each describe block references the original bug/commit and tests the specific
 * behavior that was broken. These tests run across all sandbox providers
 * (subprocess, docker, apple, k8s) where applicable.
 *
 * Bug index:
 *   1. Concurrent IPC calls misroute responses on shared socket (078a797)
 *   2. proxy.sock ENOENT after Apple Container exit (d3578af)
 *   3. Race condition: proxy.sock not ready on first message (988f286)
 *   4. Gemini sends wrong field name for tool operations (ba4fd88 / 097a390)
 *   5. Container ENTRYPOINT conflict — K8s vs Docker/Apple (8d545e8 / 95b242a)
 *   6. Bootstrap broken on first run with GCS-backed DocumentStore (6be17ea)
 *   7. Docker --read-only, --cap-drop, --network=none flags (security invariants)
 *   8. K8s security context and volume mount invariants
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { resolve, join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

// ── Helpers ──────────────────────────────────────────────────────────

function readSource(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf-8');
}

// ══════════════════════════════════════════════════════════════════════
// 1. IPC Message Correlation — concurrent calls get correct responses
// ══════════════════════════════════════════════════════════════════════

describe('regression: IPC message correlation (_msgId)', () => {
  test('client enriches every request with _msgId', () => {
    const source = readSource('src/agent/ipc-client.ts');
    // Client must generate a _msgId for each call
    expect(source).toContain('_msgId');
    expect(source).toContain('nextMsgId');
  });

  test('server echoes _msgId in every response', () => {
    const source = readSource('src/host/ipc-server.ts');
    // The respond() helper injects _msgId from the request
    expect(source).toContain('requestMsgId');
    expect(source).toMatch(/obj\._msgId\s*=\s*requestMsgId/);
  });

  test('client routes responses by _msgId, not FIFO', () => {
    const source = readSource('src/agent/ipc-client.ts');
    // Must have a pending Map keyed by msgId
    expect(source).toMatch(/pending.*Map/);
    // Must route by _msgId when available
    expect(source).toContain('parsed._msgId');
    // FIFO fallback only for backward compatibility with old hosts
    expect(source).toContain('fifo_fallback');
  });

  test('heartbeat frames include _msgId for targeted timer reset', () => {
    const source = readSource('src/host/ipc-server.ts');
    // Server heartbeat must include _msgId when available
    expect(source).toMatch(/_heartbeat.*true/);
    expect(source).toContain('_msgId');
  });

  test('client resets timer on targeted heartbeat', () => {
    const source = readSource('src/agent/ipc-client.ts');
    // When heartbeat has _msgId, reset only that call's timer
    expect(source).toContain('resetTimer');
    expect(source).toContain('_heartbeat');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Apple Container bridge socket isolation (proxy.sock ENOENT fix)
// ══════════════════════════════════════════════════════════════════════

describe('regression: Apple Container bridge socket isolation', () => {
  test('bridge sockets go in bridges/ subdirectory, not alongside proxy.sock', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    // Bridge sockets must use a 'bridges/' subdirectory
    expect(source).toContain("'bridges'");
    expect(source).toContain('bridgeDir');
    // Must mkdir bridges/ before creating socket path
    expect(source).toContain('mkdirSync(bridgeDir');
  });

  test('bridge socket path uses container name for uniqueness', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    // Each container gets a unique bridge socket path
    expect(source).toMatch(/bridgeSocketPath.*containerName/);
    expect(source).toContain('.sock');
  });

  test('host IPC socket directory is NOT the same as bridge socket directory', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    // ipcSocketDir is the parent of ipcSocket
    expect(source).toContain('dirname(config.ipcSocket)');
    // bridgeDir is ipcSocketDir/bridges/ — a subdirectory, not the same dir
    expect(source).toContain("join(ipcSocketDir, 'bridges')");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. IPC server async readiness (proxy.sock race condition fix)
// ══════════════════════════════════════════════════════════════════════

describe('regression: IPC server async readiness', () => {
  test('createIPCServer is async and awaits server.listen()', () => {
    const source = readSource('src/host/ipc-server.ts');
    // Must be async function
    expect(source).toMatch(/export\s+async\s+function\s+createIPCServer/);
    // Must return a Promise
    expect(source).toMatch(/Promise<Server>/);
    // Must await the listen callback
    expect(source).toMatch(/await\s+new\s+Promise.*resolve.*server\.listen/s);
  });

  test('server.ts awaits createIPCServer before proceeding', () => {
    const source = readSource('src/host/server.ts');
    expect(source).toMatch(/await\s+createIPCServer/);
  });

  test('agent-runtime-process.ts awaits createIPCServer', () => {
    const source = readSource('src/host/agent-runtime-process.ts');
    expect(source).toMatch(/await\s+createIPCServer/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. LLM tool parameter normalization (Gemini sends wrong field names)
// ══════════════════════════════════════════════════════════════════════

describe('regression: Gemini parameter name fallback in web handlers', () => {
  test('web_fetch falls back to req.query when req.url is missing', () => {
    const source = readSource('src/host/ipc-handlers/web.ts');
    // Must normalize url: use req.url ?? req.query
    expect(source).toMatch(/req\.url\s*\?\?\s*req\.query/);
  });

  test('tool descriptions guide models to use type field, not operation', () => {
    // The tool descriptions were updated to say "Use `type` to select:"
    // instead of "Operations:" which Gemini interpreted as a parameter name.
    // Check that ipc-tools or mcp-server uses clear parameter guidance.
    const mcpSource = readSource('src/agent/mcp-server.ts');
    const ipcToolsSource = readSource('src/agent/ipc-tools.ts');
    const combined = mcpSource + ipcToolsSource;

    // Must NOT use "Operations:" as a label (Gemini interprets as param name)
    // Note: "Operations" as part of a longer phrase is ok
    expect(combined).not.toMatch(/^Operations:\s*$/m);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. Container ENTRYPOINT handling — K8s prepends node, Docker/Apple don't
// ══════════════════════════════════════════════════════════════════════

describe('regression: container ENTRYPOINT command construction', () => {
  test('K8s spawn command includes node explicitly', () => {
    const source = readSource('src/host/server-completions.ts');
    // K8s pod `command` overrides ENTRYPOINT, so `node` must be prepended
    expect(source).toContain("isK8s ? ['node'] : []");
    // Verify the reasoning comment exists
    expect(source).toContain('K8s pod `command` overrides');
    expect(source).toContain('ENTRYPOINT');
  });

  test('Docker/Apple spawn command does NOT prepend node', () => {
    const source = readSource('src/host/server-completions.ts');
    // For Docker/Apple, the ENTRYPOINT is `node`, so we only pass the script path
    // The ternary isK8s ? ['node'] : [] means non-k8s gets empty array
    expect(source).toMatch(/isK8s\s*\?\s*\['node'\]\s*:\s*\[\]/);
  });

  test('K8s provider passes command array directly to pod spec', () => {
    const source = readSource('src/providers/sandbox/k8s.ts');
    // Verify the command is passed through without modification
    expect(source).toContain('config.command');
    // The pod spec must use command directly
    expect(source).toMatch(/command:\s*\[cmd,\s*\.\.\.args\]/);
  });

  test('Docker provider passes command after image name', () => {
    const source = readSource('src/providers/sandbox/docker.ts');
    // Docker: `docker run ... <image> <cmd> <args>`
    // The command goes after the image, which Docker passes to ENTRYPOINT
    expect(source).toContain('dockerArgs.push(image, cmd, ...args)');
  });

  test('Apple provider passes command after image name', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    // Apple: `container run ... <image> <cmd> <args>`
    expect(source).toContain('containerArgs.push(image, cmd, ...args)');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. Bootstrap seeding — DocumentStore must receive templates, not just FS
// ══════════════════════════════════════════════════════════════════════

describe('regression: bootstrap templates loaded from DocumentStore', () => {
  test('server-completions loads identity from DocumentStore, not filesystem', () => {
    const source = readSource('src/host/server-completions.ts');
    // Identity must be loaded from DocumentStore
    expect(source).toContain('loadIdentityFromDB');
    expect(source).toContain('providers.storage.documents');
  });

  test('server-completions loads skills from DocumentStore', () => {
    const source = readSource('src/host/server-completions.ts');
    expect(source).toContain('loadSkillsFromDB');
    // Must pass documents store
    expect(source).toMatch(/loadSkillsFromDB\(providers\.storage\.documents/);
  });

  test('skills are sent via stdin payload, not filesystem mount', () => {
    const source = readSource('src/host/server-completions.ts');
    expect(source).toContain('skills: skillsPayload');
    // Must NOT mount skills as a filesystem directory
    expect(source).not.toContain('mergeSkillsOverlay');
    expect(source).not.toContain('wsSkillsDir');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. Docker security invariants (network, read-only, cap-drop)
// ══════════════════════════════════════════════════════════════════════

describe('regression: Docker security hardening flags', () => {
  const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');

  test('--network=none by default, not when config.network is true', () => {
    // Default: no network
    expect(source).toContain("'--network=none'");
    // But provision/cleanup phases need network
    expect(source).toMatch(/config\.network\s*\?\s*\[\]\s*:\s*\['--network=none'\]/);
  });

  test('--read-only flag for immutable root filesystem', () => {
    expect(source).toContain("'--read-only'");
  });

  test('--cap-drop=ALL drops all Linux capabilities', () => {
    expect(source).toContain("'--cap-drop=ALL'");
  });

  test('--security-opt no-new-privileges', () => {
    expect(source).toContain("'--security-opt'");
    expect(source).toContain("'no-new-privileges'");
  });

  test('--pids-limit for process count limiting', () => {
    expect(source).toContain('--pids-limit');
  });

  test('writable /tmp via --tmpfs with noexec,nosuid', () => {
    expect(source).toMatch(/--tmpfs.*\/tmp.*noexec.*nosuid/);
  });

  test('per-tier writable flags (not old workspaceMountsWritable)', () => {
    expect(source).toContain("config.agentWorkspaceWritable ? 'rw' : 'ro'");
    expect(source).toContain("config.userWorkspaceWritable ? 'rw' : 'ro'");
    expect(source).not.toContain('workspaceMountsWritable');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. K8s security invariants and workspace volumes
// ══════════════════════════════════════════════════════════════════════

describe('regression: K8s pod spec security and volumes', () => {
  const source = readFileSync(resolve('src/providers/sandbox/k8s.ts'), 'utf-8');

  test('security context: readOnlyRootFilesystem, no privilege escalation', () => {
    expect(source).toContain('readOnlyRootFilesystem: true');
    expect(source).toContain('allowPrivilegeEscalation: false');
    expect(source).toContain('runAsNonRoot: true');
    expect(source).toContain("drop: ['ALL']");
  });

  test('no service account token, no host networking', () => {
    expect(source).toContain('automountServiceAccountToken: false');
    expect(source).toContain('hostNetwork: false');
  });

  test('all four volume mounts declared (scratch, tmp, agent-ws, user-ws)', () => {
    expect(source).toContain("name: 'scratch'");
    expect(source).toContain("name: 'tmp'");
    expect(source).toContain("name: 'agent-ws'");
    expect(source).toContain("name: 'user-ws'");
  });

  test('volumes use emptyDir with size limits', () => {
    // All volumes should have sizeLimit
    expect(source).toMatch(/name: 'scratch'.*emptyDir.*sizeLimit/s);
    expect(source).toMatch(/name: 'tmp'.*emptyDir.*sizeLimit.*64Mi/s);
  });

  test('volume mounts use canonical paths', () => {
    expect(source).toContain('CANONICAL.scratch');
    expect(source).toContain('CANONICAL.agent');
    expect(source).toContain('CANONICAL.user');
  });

  test('activeDeadlineSeconds set from config timeout', () => {
    expect(source).toMatch(/activeDeadlineSeconds.*config\.timeoutSec/);
  });

  test('LOG_LEVEL suppressed to warn in pod env', () => {
    expect(source).toContain("name: 'LOG_LEVEL'");
    expect(source).toContain("'warn'");
  });

  test('runtime class is configurable (can be empty to disable gVisor)', () => {
    // Empty string disables runtime class
    expect(source).toContain('K8S_RUNTIME_CLASS');
    expect(source).toMatch(/runtimeClass\s*\?\s*\{.*runtimeClassName/s);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 9. Apple Container IPC bridge protocol
// ══════════════════════════════════════════════════════════════════════

describe('regression: Apple Container IPC bridge protocol', () => {
  const source = readFileSync(resolve('src/providers/sandbox/apple.ts'), 'utf-8');

  test('container-side bridge socket path is well-known, not host path', () => {
    expect(source).toContain("CONTAINER_BRIDGE_SOCK = '/tmp/bridge.sock'");
    // AX_IPC_SOCKET inside container must use container-side path
    expect(source).toContain('AX_IPC_SOCKET=${CONTAINER_BRIDGE_SOCK}');
  });

  test('AX_IPC_LISTEN=1 tells agent to listen instead of connect', () => {
    expect(source).toContain("'AX_IPC_LISTEN=1'");
  });

  test('host AX_IPC_SOCKET is filtered from container env', () => {
    // The canonicalEnv sets AX_IPC_SOCKET to the host path, but inside
    // Apple containers we need the container-side path instead
    expect(source).toMatch(/filter.*AX_IPC_SOCKET/);
  });

  test('--publish-socket used for virtio-vsock forwarding', () => {
    expect(source).toContain('--publish-socket');
    expect(source).toContain('bridgeSocketPath');
    expect(source).toContain('CONTAINER_BRIDGE_SOCK');
  });

  test('bridgeSocketPath returned in SandboxProcess for host connection', () => {
    expect(source).toContain('bridgeSocketPath');
    // Only set when hasIpcSocket
    expect(source).toMatch(/hasIpcSocket\s*\?\s*\{\s*bridgeSocketPath/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 10. Canonical path consistency across all sandbox providers
// ══════════════════════════════════════════════════════════════════════

describe('regression: canonical paths consistent across providers', () => {
  test('CANONICAL paths are /workspace/{scratch,agent,user}', () => {
    const source = readSource('src/providers/sandbox/canonical-paths.ts');
    expect(source).toContain("root:     '/workspace'");
    expect(source).toContain("scratch:  '/workspace/scratch'");
    expect(source).toContain("agent:    '/workspace/agent'");
    expect(source).toContain("user:     '/workspace/user'");
  });

  test('canonicalEnv sets AX_WORKSPACE to CANONICAL.root', () => {
    const source = readSource('src/providers/sandbox/canonical-paths.ts');
    expect(source).toContain('AX_WORKSPACE: CANONICAL.root');
  });

  test('docker uses canonicalEnv for environment', () => {
    const source = readSource('src/providers/sandbox/docker.ts');
    expect(source).toContain('canonicalEnv(config)');
    expect(source).toContain('CANONICAL.scratch');
    expect(source).toContain('CANONICAL.agent');
    expect(source).toContain('CANONICAL.user');
  });

  test('apple uses canonicalEnv for environment', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    expect(source).toContain('canonicalEnv(config)');
    expect(source).toContain('CANONICAL.scratch');
    expect(source).toContain('CANONICAL.agent');
    expect(source).toContain('CANONICAL.user');
  });

  test('k8s uses canonicalEnv for environment', () => {
    const source = readSource('src/providers/sandbox/k8s.ts');
    expect(source).toContain('canonicalEnv(config)');
    expect(source).toContain('CANONICAL.scratch');
    expect(source).toContain('CANONICAL.agent');
    expect(source).toContain('CANONICAL.user');
  });

  test('subprocess uses symlinkEnv (symlink-based canonical paths)', () => {
    const source = readSource('src/providers/sandbox/subprocess.ts');
    expect(source).toContain('symlinkEnv');
    expect(source).toContain('createCanonicalSymlinks');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 11. Subprocess sandbox — symlink lifecycle and cleanup
// ══════════════════════════════════════════════════════════════════════

describe('regression: subprocess sandbox symlink lifecycle', () => {
  test('symlinks cleaned up when process exits', () => {
    const source = readSource('src/providers/sandbox/subprocess.ts');
    // exitCode.then() triggers cleanup
    expect(source).toMatch(/exitCode\.then.*cleanup/);
  });

  test('symlink env points to mount root, not real paths', () => {
    const source = readSource('src/providers/sandbox/canonical-paths.ts');
    // symlinkEnv sets AX_WORKSPACE to mountRoot (not CANONICAL.root)
    expect(source).toContain('AX_WORKSPACE: mountRoot');
  });

  test('createCanonicalSymlinks creates scratch, agent, user symlinks', () => {
    const source = readSource('src/providers/sandbox/canonical-paths.ts');
    expect(source).toContain("symlinkSync(config.workspace, join(mountRoot, 'scratch'))");
    expect(source).toContain("join(mountRoot, 'agent')");
    expect(source).toContain("join(mountRoot, 'user')");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 12. enforceTimeout correctness — SIGTERM then SIGKILL with grace period
// ══════════════════════════════════════════════════════════════════════

describe('regression: enforceTimeout SIGTERM/SIGKILL sequence', () => {
  const source = readFileSync(resolve('src/providers/sandbox/utils.ts'), 'utf-8');

  test('tracks actual exit, not just child.killed', () => {
    // child.killed is true after ANY kill() call, not after the process is dead
    expect(source).toContain('let exited = false');
    expect(source).toMatch(/child\.on\('exit'.*exited\s*=\s*true/);
  });

  test('sends SIGTERM first, then SIGKILL after grace period', () => {
    expect(source).toContain("'SIGTERM'");
    expect(source).toContain("'SIGKILL'");
    // SIGKILL is in a nested setTimeout (grace period)
    expect(source).toContain('graceSec * 1000');
  });

  test('wraps kill() in try/catch for EPERM on macOS', () => {
    expect(source).toContain('EPERM');
    // Both SIGTERM and SIGKILL kill calls are wrapped in try/catch
    expect(source).toContain("try { child.kill('SIGTERM'); } catch");
    expect(source).toContain("try { child.kill('SIGKILL'); } catch");
  });

  test('no-op when timeoutSec is undefined', () => {
    expect(source).toContain('if (!timeoutSec) return');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 13. IPC server message framing — length-prefixed binary protocol
// ══════════════════════════════════════════════════════════════════════

describe('regression: IPC message framing protocol', () => {
  test('client sends length-prefixed messages', () => {
    const source = readSource('src/agent/ipc-client.ts');
    expect(source).toContain('writeUInt32BE');
    expect(source).toContain('Buffer.concat');
  });

  test('server reads length-prefixed messages', () => {
    const source = readSource('src/host/ipc-server.ts');
    expect(source).toContain('readUInt32BE');
  });

  test('server has max message size check (10MB)', () => {
    const source = readSource('src/host/ipc-server.ts');
    expect(source).toContain('10_000_000');
    expect(source).toContain('message_too_large');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 14. Cross-provider: no identity directory mount
// ══════════════════════════════════════════════════════════════════════

describe('regression: identity files via stdin, not filesystem mount', () => {
  test('docker does not mount identity directory', () => {
    const source = readSource('src/providers/sandbox/docker.ts');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });

  test('apple does not mount identity directory', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });

  test('k8s does not mount identity directory', () => {
    const source = readSource('src/providers/sandbox/k8s.ts');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });

  test('sandbox config type has no agentDir field', () => {
    const source = readSource('src/providers/sandbox/types.ts');
    expect(source).not.toContain('agentDir');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 15. Apple Container — no --read-only due to tmpfs publish-socket bug
// ══════════════════════════════════════════════════════════════════════

describe('regression: Apple Container writable root (tmpfs publish-socket limitation)', () => {
  test('apple does NOT use --read-only flag', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    expect(source).not.toContain("'--read-only'");
  });

  test('apple documents why --read-only is disabled', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    expect(source).toContain('publish-socket');
    expect(source).toContain('tmpfs');
  });

  test('apple does NOT use --tmpfs (would hide bridge socket)', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    // No --tmpfs flag — the publish-socket forwarding agent can't find
    // sockets on tmpfs mounts
    expect(source).not.toContain("'--tmpfs'");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 16. Network isolation — only enabled for provision/cleanup phases
// ══════════════════════════════════════════════════════════════════════

describe('regression: network isolation per sandbox phase', () => {
  test('docker disables network by default, enables only when config.network=true', () => {
    const source = readSource('src/providers/sandbox/docker.ts');
    expect(source).toMatch(/config\.network\s*\?\s*\[\]\s*:\s*\['--network=none'\]/);
  });

  test('apple enables network only when config.network=true', () => {
    const source = readSource('src/providers/sandbox/apple.ts');
    // Apple uses --network default for network access
    expect(source).toMatch(/config\.network\s*\?\s*\['--network'.*'default'\]/);
  });

  test('SandboxConfig.network field documents phase-based usage', () => {
    const source = readSource('src/providers/sandbox/types.ts');
    expect(source).toContain('network');
    expect(source).toContain('provision/cleanup');
  });
});
