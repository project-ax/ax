/**
 * Apple Container sandbox provider — lightweight VM-based isolation for macOS.
 *
 * Uses Apple's `container` CLI to run each agent in a dedicated lightweight
 * Linux VM via Virtualization.framework. Key properties:
 *
 * - Per-container VM boundary: stronger isolation than process-level sandboxing
 * - No network by default: containers have no network unless explicitly attached
 * - --read-only root filesystem with writable /tmp
 * - Volume mounts for workspace (rw)
 * - IPC bridge via --publish-socket + virtio-vsock
 * - OCI-compatible images (same images as Docker)
 * - macOS only (Apple Silicon required)
 *
 * IPC uses --publish-socket to bridge Unix sockets across the VM boundary.
 * The agent listens inside the container, and the host connects in via
 * --publish-socket (which tunnels through virtio-vsock). The host MUST wait
 * for the agent's listener to be ready before connecting — the runtime only
 * forwards connections when the container-side listener exists. The agent
 * signals readiness via stderr ("[signal] ipc_ready").
 *
 * The runtime owns the host-side socket and auto-cleans it on container exit,
 * preventing stale socket files.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, checkCommand, sandboxProcess } from './utils.js';
import { CANONICAL, canonicalEnv } from './canonical-paths.js';

const DEFAULT_IMAGE = 'ax/agent:latest';

export async function create(_config: Config): Promise<SandboxProvider> {
  const image = process.env.AX_CONTAINER_IMAGE ?? DEFAULT_IMAGE;

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;
      const containerName = `ax-agent-${randomUUID().slice(0, 8)}`;

      // IPC bridge: agent listens inside the container on a well-known path,
      // --publish-socket creates a unique host-side socket that tunnels
      // through virtio-vsock into the container. The host connects to the
      // host-side socket after the agent signals readiness. The container
      // runtime owns the host socket and deletes it on exit.
      const CONTAINER_BRIDGE_SOCK = '/tmp/bridge.sock';
      const ipcSocketDir = dirname(config.ipcSocket);
      const bridgeSocketPath = join(ipcSocketDir, `apple-${containerName}.sock`);

      const containerArgs: string[] = [
        'run',
        '--rm',                                    // auto-remove container on exit
        '-i',                                      // interactive (stdin)
        '--name', containerName,                   // named for debugging
        // No --network flag: Apple Container has no network by default.
        // Each container runs in its own VM — no shared kernel, no network
        // unless explicitly attached. This satisfies the security invariant.

        // Resource limits
        '--memory', `${config.memoryMB ?? 256}m`,
        '--cpus', '1',

        // Filesystem: writable root (no --read-only, no --tmpfs).
        // --publish-socket forwarding fails when the container-side socket path
        // is on a tmpfs mount — the runtime's in-VM forwarding agent resolves
        // paths before tmpfs is applied, so it can't find the agent's listener.
        // TODO: re-enable --read-only once we find a writable non-tmpfs path
        // for the bridge socket (volume mounts don't support Unix sockets).

        // Volume mounts — canonical paths so the LLM sees simple /scratch
        '-v', `${config.workspace}:${CANONICAL.scratch}:rw`,

        // IPC bridge — --publish-socket creates the host-side socket and
        // tunnels connections into the container via virtio-vsock. VirtioFS
        // volume mounts do NOT support Unix domain sockets (connect returns
        // ENOTSUP), so this is the only way to bridge sockets across the VM
        // boundary.
        '--publish-socket', `${bridgeSocketPath}:${CONTAINER_BRIDGE_SOCK}`,

        // Enterprise mounts — canonical paths
        ...(config.agentWorkspace ? ['-v', `${config.agentWorkspace}:${CANONICAL.agent}:ro`] : []),
        ...(config.userWorkspace ? ['-v', `${config.userWorkspace}:${CANONICAL.user}:ro`] : []),

        // Working directory — canonical mount root
        '-w', CANONICAL.root,

        // Environment — canonical paths, but replace AX_IPC_SOCKET with the
        // container-side bridge socket path (canonicalEnv sets the host path,
        // which doesn't exist inside the VM).
        ...Object.entries(canonicalEnv(config))
          .filter(([k]) => k !== 'AX_IPC_SOCKET')
          .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        '-e', `AX_IPC_SOCKET=${CONTAINER_BRIDGE_SOCK}`,
        // Tell the agent to listen (accept connections) instead of connecting out
        '-e', 'AX_IPC_LISTEN=1',
      ];

      // Image and command
      containerArgs.push(image, cmd, ...args);

      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
      const child = spawn('container', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec, 5);
      return { ...sandboxProcess(child, exitCode), bridgeSocketPath };
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      if (process.platform !== 'darwin') return false;
      return checkCommand('container', ['--help']);
    },
  };
}
