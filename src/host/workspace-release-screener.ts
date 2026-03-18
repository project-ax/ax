/**
 * Release-time screening for skill files and binaries.
 *
 * Inspects workspace changes before GCS commit:
 * - Skill files (skills dir .md files): parsed and screened via screener provider
 * - Binary files (bin dir): size limit enforced
 * - Other files: passed through without screening
 */

import { parseAgentSkill } from '../utils/skill-format-parser.js';
import type { AuditProvider } from '../providers/audit/types.js';
import type { SkillScreenerProvider } from '../providers/screener/types.js';
import type { FileChange, FileRejection, WorkspaceScope } from '../providers/workspace/types.js';
import type { CommitScreener } from '../providers/workspace/shared.js';

const DEFAULT_MAX_BINARY_SIZE = 100 * 1024 * 1024; // 100MB

export interface WorkspaceChange {
  scope: 'agent' | 'user' | 'session';
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content?: Buffer;
  size: number;
}

export interface ScreeningOptions {
  screener?: SkillScreenerProvider;
  audit: AuditProvider;
  sessionId: string;
  maxBinarySize?: number;
}

export interface ScreeningResult {
  accepted: WorkspaceChange[];
  rejected: Array<WorkspaceChange & { reason: string }>;
}

export async function screenReleaseChanges(
  changes: WorkspaceChange[],
  opts: ScreeningOptions,
): Promise<ScreeningResult> {
  const accepted: WorkspaceChange[] = [];
  const rejected: ScreeningResult['rejected'] = [];
  const maxBinSize = opts.maxBinarySize ?? DEFAULT_MAX_BINARY_SIZE;

  for (const change of changes) {
    if (change.type === 'deleted') {
      accepted.push(change);
      continue;
    }

    const isSkill = /\bskills\/.*\.md$/i.test(change.path);
    const isBinary = /\bbin\//.test(change.path);

    if (isSkill && change.content && opts.screener) {
      const content = change.content.toString('utf-8');
      const parsed = parseAgentSkill(content);

      if (opts.screener.screenExtended) {
        const result = await opts.screener.screenExtended(content, parsed.permissions);
        if (result.verdict === 'REJECT') {
          const reasons = result.reasons?.map((r: any) => r.detail) ?? [];
          rejected.push({ ...change, reason: `Skill screening failed: ${reasons.join(', ')}` });
          await opts.audit.log({ action: 'skill_release_rejected', sessionId: opts.sessionId, args: { path: change.path, reasons } });
          continue;
        }
      } else if (opts.screener.screen) {
        const result = await opts.screener.screen(content, parsed.permissions);
        if (!result.allowed) {
          rejected.push({ ...change, reason: `Skill screening failed: ${result.reasons.join(', ')}` });
          await opts.audit.log({ action: 'skill_release_rejected', sessionId: opts.sessionId, args: { path: change.path, reasons: result.reasons } });
          continue;
        }
      }
    }

    if (isBinary && change.size > maxBinSize) {
      rejected.push({ ...change, reason: `Binary exceeds size limit (${change.size} > ${maxBinSize})` });
      await opts.audit.log({ action: 'binary_release_rejected', sessionId: opts.sessionId, args: { path: change.path, size: change.size, limit: maxBinSize } });
      continue;
    }

    accepted.push(change);
  }

  return { accepted, rejected };
}

/**
 * Create a CommitScreener callback for the workspace orchestrator.
 * Returns undefined when no screener or audit provider is available
 * (workspace commits proceed without screening in that case).
 */
export function createCommitScreener(
  screener?: SkillScreenerProvider,
  audit?: AuditProvider,
): CommitScreener | undefined {
  if (!screener || !audit) return undefined;

  return async (
    sessionId: string,
    scope: WorkspaceScope,
    changes: FileChange[],
  ): Promise<{ accepted: FileChange[]; rejections: FileRejection[] }> => {
    const wsChanges: WorkspaceChange[] = changes.map(c => ({ ...c, scope }));
    const result = await screenReleaseChanges(wsChanges, { screener, audit, sessionId });
    return {
      accepted: result.accepted.map(a => ({
        path: a.path, type: a.type, content: a.content, size: a.size,
      })),
      rejections: result.rejected.map(r => ({ path: r.path, reason: r.reason })),
    };
  };
}
