// src/providers/skills/types.ts — Skills provider types

export interface SkillMeta {
  name: string;
  description?: string;
  path: string;
}

export interface SkillProposal {
  skill: string;
  content: string;
  reason?: string;
}

export interface ProposalResult {
  id: string;
  verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
  reason: string;
}

export interface LogOptions {
  limit?: number;
  since?: Date;
}

export interface SkillLogEntry {
  id: string;
  skill: string;
  action: 'propose' | 'approve' | 'reject' | 'remove';
  timestamp: Date;
  reason?: string;
}

export interface SkillStoreProvider {
  list(): Promise<SkillMeta[]>;
  read(name: string): Promise<string>;
  propose(proposal: SkillProposal): Promise<ProposalResult>;
  approve(proposalId: string): Promise<void>;
  reject(proposalId: string): Promise<void>;
  remove(name: string): Promise<void>;
  log(opts?: LogOptions): Promise<SkillLogEntry[]>;
}

export interface ScreeningVerdict {
  allowed: boolean;
  reasons: string[];
}

// ═══════════════════════════════════════════════════════
// Extended screening types (Phase 3 — static screener)
// ═══════════════════════════════════════════════════════

export type ScreeningSeverity = 'INFO' | 'FLAG' | 'BLOCK';
export type ScreeningVerdictKind = 'APPROVE' | 'REVIEW' | 'REJECT';

export interface ScreeningReason {
  category: string;
  severity: ScreeningSeverity;
  detail: string;
  line?: number;
}

export interface ExtendedScreeningVerdict {
  verdict: ScreeningVerdictKind;
  score: number;
  reasons: ScreeningReason[];
  permissions: string[];
  excessPermissions: string[];
}

// ═══════════════════════════════════════════════════════
// Parsed AgentSkills format (SKILL.md)
// ═══════════════════════════════════════════════════════

/** @deprecated Use SkillInstallStep instead. Kept for backward-compat parsing. */
export interface AgentSkillInstaller {
  kind: string;
  package: string;
  bins?: string[];
  os?: string[];
  label?: string;
}

/**
 * New install step format: raw `run` commands instead of structured kind/package taxonomy.
 * Each step is a shell command to execute on the host, with optional declarative metadata.
 */
export interface SkillInstallStep {
  run: string;
  label?: string;
  bin?: string;    // Declarative binary name for PATH lookup (not an executable command)
  os?: string[];
}

export interface ParsedAgentSkill {
  name: string;
  description?: string;
  version?: string;
  license?: string;
  homepage?: string;
  requires: {
    bins: string[];
    env: string[];
    anyBins?: string[][];
    config?: Record<string, string>;
  };
  install: SkillInstallStep[];
  os?: string[];
  permissions: string[];
  triggers?: string[];
  tags?: string[];
  body: string;
  codeBlocks: string[];
}

// ═══════════════════════════════════════════════════════
// Generated manifest
// ═══════════════════════════════════════════════════════

export interface GeneratedManifest {
  name: string;
  description?: string;
  version?: string;
  requires: {
    bins: string[];
    env: string[];
    os?: string[];
  };
  capabilities: {
    tools: string[];
    host_commands: string[];
    domains: string[];
  };
  install: {
    steps: Array<{
      run: string;
      label?: string;
      bin?: string;
      os?: string[];
      approval: 'required';
    }>;
  };
  executables: Array<{
    path: string;
    sha256?: string;
  }>;
}

// ═══════════════════════════════════════════════════════
// Install state & response types
// ═══════════════════════════════════════════════════════

/** Persisted install progress for a skill, scoped per agent. */
export interface SkillInstallState {
  agentId: string;
  skillName: string;
  inspectToken: string;     // SHA-256 of the install steps at time of last inspect
  steps: Array<{
    run: string;
    status: 'pending' | 'skipped' | 'completed' | 'failed';
    updatedAt: string;
    output?: string;
    error?: string;
  }>;
  status: 'not_started' | 'in_progress' | 'completed' | 'partial' | 'failed';
  updatedAt: string;
}

/** Response from the inspect phase of skill_install. */
export interface SkillInstallInspectResponse {
  skill: string;
  status: 'needs_install' | 'satisfied';
  inspectToken: string;
  binChecks: Array<{ bin: string; found: boolean }>;
  steps: Array<{
    index: number;
    run: string;
    label: string;
    status: 'needed' | 'satisfied' | 'invalid';
    bin?: string;
    binFound?: boolean;
    validationError?: string;
  }>;
}

export interface SkillScreenerProvider {
  screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict>;
  screenExtended?(content: string, declaredPermissions?: string[]): Promise<ExtendedScreeningVerdict>;
  screenBatch?(items: Array<{ content: string; declaredPermissions?: string[] }>): Promise<ExtendedScreeningVerdict[]>;
}
