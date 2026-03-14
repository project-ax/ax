/**
 * Git-backed skill store provider.
 *
 * Skills are stored as files in a git repository. Modifications go through a
 * propose → review → approve/reject → commit workflow. Hard-reject patterns
 * (shell, base64, eval) are never overridable.
 *
 * Uses isomorphic-git for git operations (no native git dependency required).
 * All file paths use safePath() (SC-SEC-004).
 */

import * as git from 'isomorphic-git';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import { agentSkillsDir } from '../../paths.js';
import type {
  SkillStoreProvider,
  SkillScreenerProvider,
  SkillMeta,
  SkillProposal,
  ProposalResult,
  SkillLogEntry,
  LogOptions,
} from './types.js';
import type { Config } from '../../types.js';

// ═══════════════════════════════════════════════════════
// Hard-reject patterns (never overridable)
// ═══════════════════════════════════════════════════════

const HARD_REJECT_PATTERNS: { regex: RegExp; reason: string }[] = [
  // Shell execution
  { regex: /\bexec\s*\(/i, reason: 'exec() call detected' },
  { regex: /\bchild_process\b/i, reason: 'child_process module reference' },
  { regex: /\bspawn\s*\(/i, reason: 'spawn() call detected' },
  { regex: /\bexecSync\s*\(/i, reason: 'execSync() call detected' },
  { regex: /\$\(\s*(curl|wget|nc|bash|sh)\b/i, reason: 'shell command substitution' },
  { regex: /\|\s*(bash|sh|zsh|cmd|powershell)\b/i, reason: 'pipe to shell' },

  // Code execution
  { regex: /\beval\s*\(/i, reason: 'eval() call detected' },
  { regex: /\bnew\s+Function\s*\(/i, reason: 'Function constructor detected' },

  // Encoding-based evasion
  { regex: /\batob\s*\(/i, reason: 'atob() (base64 decode) detected' },
  { regex: /\bBuffer\.from\s*\([^)]*,\s*['"]base64['"]\s*\)/i, reason: 'base64 Buffer.from detected' },

  // Dangerous imports
  { regex: /\brequire\s*\(\s*['"](?:child_process|net|dgram|cluster|worker_threads)['"]\s*\)/i, reason: 'dangerous module require' },
  { regex: /\bimport\s+.*from\s+['"](?:child_process|net|dgram|cluster|worker_threads)['"]/i, reason: 'dangerous module import' },

  // Network access
  { regex: /\bfetch\s*\(/i, reason: 'fetch() call detected (network access)' },
  { regex: /\bXMLHttpRequest\b/i, reason: 'XMLHttpRequest reference' },
];

// ═══════════════════════════════════════════════════════
// Capability patterns (flag for review)
// ═══════════════════════════════════════════════════════

const CAPABILITY_PATTERNS: { regex: RegExp; capability: string }[] = [
  { regex: /\bfs\b.*\b(write|unlink|rm|mkdir|append)/i, capability: 'filesystem-write' },
  { regex: /\bprocess\.env\b/i, capability: 'env-access' },
  { regex: /\bprocess\.exit\b/i, capability: 'process-exit' },
  { regex: /\bcrypto\b/i, capability: 'crypto-access' },
];

// ═══════════════════════════════════════════════════════
// Proposal state
// ═══════════════════════════════════════════════════════

interface PendingProposal {
  id: string;
  skill: string;
  /** Relative filepath within git dir (e.g. "deploy.md" or "deploy/SKILL.md") */
  gitFilepath: string;
  content: string;
  reason?: string;
  verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
  rejectReason?: string;
  capabilities: string[];
  createdAt: Date;
}

// ═══════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════

export async function create(config: Config, _name?: string, opts?: { screener?: SkillScreenerProvider; [key: string]: unknown }): Promise<SkillStoreProvider> {
  const screener = opts?.screener;
  const skillsDir = agentSkillsDir('main');
  const gitDir = skillsDir;

  // Ensure skills directory exists
  fs.mkdirSync(skillsDir, { recursive: true });

  // Initialize git repo if needed
  try {
    await git.findRoot({ fs, filepath: skillsDir });
  } catch {
    await git.init({ fs, dir: gitDir });
    // Initial commit with any existing files (flat .md and directory-based SKILL.md)
    const existingEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const filesToAdd: string[] = [];
    for (const entry of existingEntries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        filesToAdd.push(entry.name);
      } else if (entry.isDirectory()) {
        const skillMd = join(entry.name, 'SKILL.md');
        if (fs.existsSync(join(skillsDir, skillMd))) {
          filesToAdd.push(skillMd);
        }
      }
    }
    for (const file of filesToAdd) {
      await git.add({ fs, dir: gitDir, filepath: file });
    }
    if (filesToAdd.length > 0) {
      await git.commit({
        fs, dir: gitDir,
        message: 'Initial skills commit',
        author: { name: 'ax', email: 'ax@localhost' },
      });
    }
  }

  // In-memory proposal store
  const proposals = new Map<string, PendingProposal>();

  // In-memory log
  const logEntries: SkillLogEntry[] = [];

  function addLog(skill: string, action: SkillLogEntry['action'], reason?: string): string {
    const id = randomUUID();
    logEntries.push({
      id,
      skill,
      action,
      timestamp: new Date(),
      reason,
    });
    return id;
  }

  async function validateContent(content: string): Promise<{
    verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
    reason?: string;
    capabilities: string[];
  }> {
    // Delegate to screener provider when available
    if (screener?.screenExtended) {
      const ext = await screener.screenExtended(content);
      const verdict = ext.verdict === 'APPROVE' ? 'AUTO_APPROVE'
        : ext.verdict === 'REVIEW' ? 'NEEDS_REVIEW'
        : 'REJECT';
      return {
        verdict,
        reason: ext.reasons.length > 0 ? ext.reasons.map(r => r.detail).join('; ') : undefined,
        capabilities: ext.permissions,
      };
    }

    // Inline fallback: hard-reject patterns
    for (const pattern of HARD_REJECT_PATTERNS) {
      if (pattern.regex.test(content)) {
        return {
          verdict: 'REJECT',
          reason: `Hard reject: ${pattern.reason}`,
          capabilities: [],
        };
      }
    }

    // Inline fallback: capability patterns
    const capabilities: string[] = [];
    for (const pattern of CAPABILITY_PATTERNS) {
      if (pattern.regex.test(content)) {
        capabilities.push(pattern.capability);
      }
    }

    if (capabilities.length > 0) {
      return {
        verdict: 'NEEDS_REVIEW',
        reason: `Capabilities detected: ${capabilities.join(', ')}`,
        capabilities,
      };
    }

    return { verdict: 'AUTO_APPROVE', capabilities: [] };
  }

  async function getDriftStats(): Promise<{ totalFiles: number; totalChanges: number }> {
    let totalFiles = 0;
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          totalFiles++;
        } else if (entry.isDirectory() && fs.existsSync(join(skillsDir, entry.name, 'SKILL.md'))) {
          totalFiles++;
        }
      }
    } catch {
      // empty
    }
    let totalChanges = 0;

    try {
      const log = await git.log({ fs, dir: gitDir, depth: 100 });
      totalChanges = log.length;
    } catch {
      // No commits yet
    }

    return { totalFiles, totalChanges };
  }

  return {
    async list(): Promise<SkillMeta[]> {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const results: SkillMeta[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          // File-based skill: greeting.md → name "greeting"
          results.push({
            name: entry.name.replace(/\.md$/, ''),
            path: safePath(skillsDir, entry.name),
          });
        } else if (entry.isDirectory()) {
          // Directory-based skill: deploy/SKILL.md → name "deploy"
          const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillMdPath)) {
            results.push({
              name: entry.name,
              path: safePath(skillsDir, entry.name, 'SKILL.md'),
            });
          }
        }
      }
      return results;
    },

    async read(name: string): Promise<string> {
      // Try file-based first: {name}.md
      const filePath = safePath(skillsDir, `${name}.md`);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
      // Try directory-based: {name}/SKILL.md
      const dirSkillPath = safePath(skillsDir, name, 'SKILL.md');
      return fs.readFileSync(dirSkillPath, 'utf-8');
    },

    async propose(proposal: SkillProposal): Promise<ProposalResult> {
      const { skill, content, reason } = proposal;

      // Determine if this is a directory-based skill (existing dir with SKILL.md)
      const dirSkillPath = safePath(skillsDir, skill, 'SKILL.md');
      const safeSkillDir = safePath(skillsDir, skill);
      const isDirectorySkill = fs.existsSync(safeSkillDir) &&
        fs.statSync(safeSkillDir).isDirectory();

      // Sanitize skill name via safePath (SC-SEC-004) and extract the safe filename
      const safeFilePath = isDirectorySkill ? dirSkillPath : safePath(skillsDir, `${skill}.md`);
      // Git filepath relative to gitDir
      const safeFilename = isDirectorySkill
        ? join(basename(safeSkillDir), 'SKILL.md')
        : basename(safeFilePath); // e.g. "my-skill.md"
      // Sanitized skill name (directory name for dir-based, stem for file-based)
      const safeName = isDirectorySkill
        ? basename(safeSkillDir)
        : basename(safeFilePath).replace(/\.md$/, '');

      // Validate content
      const validation = await validateContent(content);

      const id = randomUUID();
      const pending: PendingProposal = {
        id,
        skill: safeName, // store sanitized name
        gitFilepath: safeFilename, // relative path for git operations
        content,
        reason,
        verdict: validation.verdict,
        rejectReason: validation.reason,
        capabilities: validation.capabilities,
        createdAt: new Date(),
      };

      if (validation.verdict === 'REJECT') {
        addLog(skill, 'reject', validation.reason);
        // Don't store rejected proposals
        return {
          id,
          verdict: 'REJECT',
          reason: validation.reason ?? 'Content rejected by security scan',
        };
      }

      // Store proposal for review/approval
      proposals.set(id, pending);
      addLog(pending.skill, 'propose', validation.reason);

      if (validation.verdict === 'AUTO_APPROVE') {
        // Auto-approve: write file and commit immediately
        if (isDirectorySkill) {
          fs.mkdirSync(join(skillsDir, basename(safeSkillDir)), { recursive: true });
        }
        fs.writeFileSync(safeFilePath, content, 'utf-8');

        await git.add({ fs, dir: gitDir, filepath: safeFilename });
        await git.commit({
          fs, dir: gitDir,
          message: `skill: auto-approve ${pending.skill}\n\n${reason ?? 'No reason provided'}`,
          author: { name: 'ax', email: 'ax@localhost' },
        });

        addLog(pending.skill, 'approve', 'Auto-approved: no dangerous capabilities detected');
        proposals.delete(id);

        return {
          id,
          verdict: 'AUTO_APPROVE',
          reason: 'Content passes all security checks — auto-approved and committed',
        };
      }

      // NEEDS_REVIEW
      return {
        id,
        verdict: 'NEEDS_REVIEW',
        reason: validation.reason ?? 'Content requires manual review',
      };
    },

    async approve(proposalId: string): Promise<void> {
      const pending = proposals.get(proposalId);
      if (!pending) {
        throw new Error(`Proposal not found: ${proposalId}`);
      }

      if (pending.verdict === 'REJECT') {
        throw new Error(`Cannot approve a rejected proposal: ${pending.rejectReason}`);
      }

      // Write file and commit using stored git filepath
      const safeFilename = pending.gitFilepath;
      const filePath = join(skillsDir, safeFilename);
      // Ensure parent directory exists for directory-based skills
      const parentDir = join(filePath, '..');
      fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(filePath, pending.content, 'utf-8');

      await git.add({ fs, dir: gitDir, filepath: safeFilename });
      const commitOid = await git.commit({
        fs, dir: gitDir,
        message: `skill: approve ${pending.skill}\n\n${pending.reason ?? 'No reason provided'}\nCapabilities: ${pending.capabilities.join(', ')}`,
        author: { name: 'ax', email: 'ax@localhost' },
      });

      addLog(pending.skill, 'approve', `Manually approved (commit: ${commitOid.slice(0, 7)})`);
      proposals.delete(proposalId);
    },

    async reject(proposalId: string): Promise<void> {
      const pending = proposals.get(proposalId);
      if (!pending) {
        throw new Error(`Proposal not found: ${proposalId}`);
      }

      addLog(pending.skill, 'reject', 'Manually rejected by user');
      proposals.delete(proposalId);
    },

    async revert(commitId: string): Promise<void> {
      // Find the commit to revert
      let commits: Awaited<ReturnType<typeof git.log>>;
      try {
        commits = await git.log({ fs, dir: gitDir, depth: 100 });
      } catch {
        throw new Error(`Commit not found: ${commitId}`);
      }
      const commitToRevert = commits.find(c => c.oid.startsWith(commitId));

      if (!commitToRevert) {
        throw new Error(`Commit not found: ${commitId}`);
      }

      // Get parent commit's tree
      const parentOid = commitToRevert.commit.parent[0];
      if (!parentOid) {
        throw new Error('Cannot revert the initial commit');
      }

      // Read parent tree to restore files
      const parentFiles = await git.listFiles({ fs, dir: gitDir, ref: parentOid });
      const currentFiles = await git.listFiles({ fs, dir: gitDir, ref: commitToRevert.oid });

      // Files added in the commit (remove them)
      const addedFiles = currentFiles.filter(f => !parentFiles.includes(f));
      for (const file of addedFiles) {
        const filePath = safePath(skillsDir, file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          await git.remove({ fs, dir: gitDir, filepath: file });
        }
      }

      // Files modified or deleted (restore from parent)
      for (const file of parentFiles) {
        const blob = await git.readBlob({ fs, dir: gitDir, oid: parentOid, filepath: file });
        const filePath = safePath(skillsDir, file);
        fs.writeFileSync(filePath, Buffer.from(blob.blob));
        await git.add({ fs, dir: gitDir, filepath: file });
      }

      await git.commit({
        fs, dir: gitDir,
        message: `skill: revert ${commitToRevert.oid.slice(0, 7)}\n\nReverting: ${commitToRevert.commit.message}`,
        author: { name: 'ax', email: 'ax@localhost' },
      });

      // Extract skill name from commit message
      const skillMatch = commitToRevert.commit.message.match(/skill:\s+\w+\s+(\S+)/);
      addLog(skillMatch?.[1] ?? 'unknown', 'revert', `Reverted commit ${commitToRevert.oid.slice(0, 7)}`);
    },

    async log(opts?: LogOptions): Promise<SkillLogEntry[]> {
      let entries = [...logEntries];

      if (opts?.since) {
        entries = entries.filter(e => e.timestamp >= opts.since!);
      }

      // Sort by timestamp descending (newest first)
      entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      if (opts?.limit) {
        entries = entries.slice(0, opts.limit);
      }

      return entries;
    },
  };
}
