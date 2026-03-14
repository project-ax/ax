// src/providers/sandbox/types.ts — Sandbox provider types

export interface SandboxConfig {
  workspace: string;
  ipcSocket: string;
  timeoutSec?: number;
  memoryMB?: number;
  command: string[];

  // ── Enterprise mounts (optional) ──
  /** Agent's shared workspace: ~/.ax/agents/<id>/agent/workspace/ */
  agentWorkspace?: string;
  /** Per-user workspace: ~/.ax/agents/<id>/users/<userId>/workspace/ */
  userWorkspace?: string;
  /** When true, agent/user workspace mounts are read-write (workspace provider validates at commit). */
  workspaceMountsWritable?: boolean;
}

export interface SandboxProcess {
  pid: number;
  exitCode: Promise<number>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill(): void;
}

export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;
}
