// src/providers/workspace/types.ts — Workspace provider types
//
// Manages persistent file workspaces for agent sessions with three scopes
// (agent, user, session), automatic change detection, and scan-before-persist
// semantics.

// ═══════════════════════════════════════════════════════
// Scopes & Mounts
// ═══════════════════════════════════════════════════════

export type WorkspaceScope = 'agent' | 'user' | 'session';

export interface WorkspaceMounts {
  /** Paths the sandbox should bind-mount (one per activated scope). */
  paths: Partial<Record<WorkspaceScope, string>>;
}

// ═══════════════════════════════════════════════════════
// Commit Results
// ═══════════════════════════════════════════════════════

export interface CommitResult {
  scopes: Partial<Record<WorkspaceScope, ScopeCommitResult>>;
}

export interface ScopeCommitResult {
  status: 'committed' | 'rejected' | 'empty';
  filesChanged: number;
  bytesChanged: number;
  rejections?: FileRejection[];
}

export interface FileRejection {
  path: string;
  reason: string;
}

// ═══════════════════════════════════════════════════════
// File Changes
// ═══════════════════════════════════════════════════════

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content?: Buffer; // undefined for deletes
  size: number;
}

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

export interface WorkspaceConfig {
  basePath: string;
  maxFileSize: number;
  maxFiles: number;
  maxCommitSize: number;
  ignorePatterns: string[];
}

// ═══════════════════════════════════════════════════════
// Backend Sub-Interface
// ═══════════════════════════════════════════════════════

export interface WorkspaceBackend {
  /** Set up workspace with current persisted state as base. Returns merged path. */
  mount(scope: WorkspaceScope, id: string): Promise<string>;

  /** Compute changeset since mount. */
  diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>;

  /** Persist approved changes. */
  commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Provider Interface
// ═══════════════════════════════════════════════════════

export interface WorkspaceProvider {
  /** Activate scopes and populate content into workspace directories. */
  mount(sessionId: string, scopes: WorkspaceScope[]): Promise<WorkspaceMounts>;

  /** Diff, scan, and persist changes for all mounted scopes. */
  commit(sessionId: string): Promise<CommitResult>;

  /** Clean up session scope, unmount overlays. */
  cleanup(sessionId: string): Promise<void>;

  /** Returns which scopes are currently active for a session. */
  activeMounts(sessionId: string): WorkspaceScope[];
}
