# Provider Lessons: Sandbox

### Container providers need ipcSocket guards for ephemeral tool containers
**Date:** 2026-03-15
**Context:** When implementing agent-in-container, sandbox_bash spawns ephemeral containers via the same Docker/Apple provider. Tool containers don't need IPC (they're fire-and-forget), so ipcSocket is empty string.
**Lesson:** Guard all socket-related logic in Docker/Apple providers with `if (config.ipcSocket)`. Docker needs it for the `-v socketDir:socketDir:rw` mount. Apple needs it for `--publish-socket`, bridge socket path computation, and IPC env vars (AX_IPC_SOCKET, AX_IPC_LISTEN). Empty string = no socket setup.
**Tags:** sandbox, docker, apple-container, ipcSocket, ephemeral-containers

### Apple Container --publish-socket requires listener-ready signaling
**Date:** 2026-03-14
**Context:** IPC bridge via --publish-socket hung silently — host connected to host-side socket but the runtime never forwarded to the container's listener. Root cause: host connected before the agent's Node.js process finished booting and called `net.Server.listen()`.
**Lesson:** The Apple Container runtime only forwards --publish-socket connections when a listener already exists at the container-side path. Use a stderr signal (`[signal] ipc_ready`) emitted from the `listen()` callback. The host MUST wait for this signal before connecting to the host-side socket. This is critical because Node.js takes seconds to boot inside the VM, while the host-side socket is available immediately.
**Tags:** apple-container, publish-socket, virtio-vsock, timing, IPC

### Apple Container --tmpfs hides sockets from --publish-socket forwarding
**Date:** 2026-03-14
**Context:** Even after fixing the timing issue, IPC bridge still failed. `ipc_listen_accepted` never appeared despite the agent's listener being ready and the host connecting to the bridge socket.
**Lesson:** `--tmpfs /tmp` creates a filesystem overlay that the --publish-socket runtime's in-VM forwarding agent cannot see through. Sockets created on tmpfs are invisible to the forwarding mechanism. Don't use `--read-only` + `--tmpfs` for paths used by --publish-socket. The VM boundary already provides security isolation, so a writable root filesystem is an acceptable trade-off.
**Tags:** apple-container, tmpfs, publish-socket, filesystem, IPC

### Provider map path regex must allow digits in provider names
**Date:** 2026-03-04
**Context:** Adding `k8s-pod` to sandbox providers caused provider-map.test.ts and phase2.test.ts to fail — their path validation regex was `[a-z-]+` which doesn't match digits.
**Lesson:** When adding providers with digits in their names (e.g., `k8s-pod`), update path validation regexes from `[a-z-]+` to `[a-z0-9-]+` in provider-map.test.ts and phase2.test.ts.
**Tags:** provider-map, regex, testing, k8s

### Mock k8s client-node with class syntax, not vi.fn().mockImplementation()
**Date:** 2026-03-04
**Context:** Mocking `@kubernetes/client-node` with `vi.fn().mockImplementation(...)` for `KubeConfig` failed with "is not a constructor" when used with dynamic `import()`.
**Lesson:** Use actual class definitions (`class MockKubeConfig { ... }`) in `vi.mock()` factories instead of `vi.fn().mockImplementation()` when mocking constructors that will be used with `new`.
**Tags:** vitest, mocking, kubernetes, dynamic-import

### K8s sandbox uses pure NATS — no exec, no attach, no stdin/stdout
**Date:** 2026-03-16
**Context:** Eliminated all k8s Exec/Attach API usage for sandbox communication. Warm and cold pods communicate entirely via NATS.
**Lesson:** In k8s mode, the sandbox provider returns `podName` + dummy streams (ended immediately). The host publishes work to `agent.work.{podName}` via NATS. The agent processes work and sends response via `agent_response` IPC action. `processCompletion` in server-completions.ts checks `proc.podName && deps.publishWork` to use NATS delivery instead of stdin. The `agentResponsePromise` on CompletionDeps replaces stdout capture. Subprocess/seatbelt modes are completely unchanged — they still use stdin/stdout.
**Tags:** k8s, nats, sandbox, pure-nats, architecture

### child.killed is true after ANY kill() call, not just after the process is dead
**Date:** 2026-02-22
**Context:** `enforceTimeout` was checking `child.killed` to skip SIGKILL after SIGTERM, but `child.killed` is set to `true` the moment `kill()` is called, regardless of whether the process actually exited.
**Lesson:** Use a custom `exited` flag set via `child.on('exit', ...)` to track whether the process has actually terminated. Don't rely on `child.killed` to mean "the process is dead" — it only means "we've called kill() on it".
**Tags:** child_process, node.js, signals, SIGTERM, SIGKILL, sandbox

### Never use tsx binary as a process wrapper — use `node --import tsx/esm` instead
**Date:** 2026-02-27
**Context:** Diagnosing agent delegation failures — tsx wrapper caused EPERM, orphaned processes, and corrupted exit codes
**Lesson:** The tsx binary (`node_modules/.bin/tsx`) spawns a child Node.js process and relays signals via `relaySignalToChild`. On macOS, this relay fails with EPERM, and tsx has no error handling for it. Always use `node --import <absolute-path-to-tsx/dist/esm/index.mjs>` instead — single process, no signal relay issues. The absolute path is mandatory because agents run with cwd=workspace (temp dir with no node_modules).
**Tags:** tsx, process management, macOS, signal handling, EPERM, sandbox
