/**
 * Validates staged git diffs for .ax/ files before committing.
 *
 * Enforces:
 * - Only allowed paths under .ax/ (skills/, policy/, SOUL.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md)
 * - File size limits (32KB for identity, 64KB for skills)
 */

import { getLogger } from '../logger.js';
import { parseSkillFile } from '../skills/parser.js';

const logger = getLogger().child({ component: 'validate-commit' });

/** Regex matching the canonical `.ax/skills/<name>/SKILL.md` location. A
 *  `SKILL.md` anywhere else in the tree (e.g. `.ax/policy/SKILL.md`) is
 *  treated as an ordinary file, not a skill definition. */
const SKILL_MD_RE = /^\.ax\/skills\/[^/]+\/SKILL\.md$/;

/** Allowed path prefixes under .ax/ */
const ALLOWED_PREFIXES = [
  '.ax/skills/',
  '.ax/policy/',
];

/** Allowed exact files under .ax/ */
const ALLOWED_FILES = [
  '.ax/SOUL.md',
  '.ax/IDENTITY.md',
  '.ax/AGENTS.md',
  '.ax/HEARTBEAT.md',
];

/**
 * Git pathspec for `git diff --cached --` to extract .ax/ changes.
 * Single source of truth — used by hostGitCommit (local) and git-sidecar (k8s).
 * We diff the entire .ax/ directory; validateCommit() rejects disallowed paths.
 */
export const AX_DIFF_PATHSPEC = '.ax/';

/** Max content size per file in bytes */
const MAX_IDENTITY_SIZE = 32_768;
const MAX_SKILL_SIZE = 65_536;

export interface ValidateCommitResult {
  ok: boolean;
  reason?: string;
}

/**
 * Parse a unified diff into per-file entries with added content.
 */
function parseDiff(diff: string): Array<{ path: string; addedContent: string }> {
  const files: Array<{ path: string; addedContent: string }> = [];
  // Split on diff headers
  const parts = diff.split(/^diff --git /m).filter(Boolean);

  for (const part of parts) {
    // Extract path from "a/.ax/foo b/.ax/foo"
    const headerMatch = part.match(/^a\/(.+?) b\/(.+?)$/m);
    if (!headerMatch) continue;
    const filePath = headerMatch[2];

    // Extract added lines (lines starting with +, excluding +++ header)
    const addedLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('+++')) continue;
      if (line.startsWith('+')) {
        addedLines.push(line.slice(1)); // Remove the + prefix
      }
    }

    files.push({ path: filePath, addedContent: addedLines.join('\n') });
  }

  return files;
}

/**
 * Check if a file path is in the allowed set.
 */
function isAllowedPath(filePath: string): boolean {
  if (ALLOWED_FILES.includes(filePath)) return true;
  return ALLOWED_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

/**
 * Get the max size limit for a file path.
 */
function getMaxSize(filePath: string): number {
  if (filePath.startsWith('.ax/skills/')) return MAX_SKILL_SIZE;
  return MAX_IDENTITY_SIZE;
}

/** A single file's full content, passed alongside the diff so the host can
 *  run deeper checks (currently: SKILL.md frontmatter schema) that need the
 *  whole file rather than just the added lines in the diff. */
export interface FullFile {
  path: string;
  content: string;
}

/**
 * Validate a staged diff for .ax/ files.
 * Returns { ok: true } if valid, or { ok: false, reason } if rejected.
 *
 * `files` (optional) carries full contents for deeper per-file checks.
 * Today that's just SKILL.md frontmatter validation — without the full
 * content, a partial-diff hunk wouldn't include the `---` delimiters and
 * the schema check would spuriously pass. The sidecar collects contents
 * for the narrow path we care about (`.ax/skills/*​/SKILL.md`) and sends
 * them here; the diff still gates path+size.
 */
export function validateCommit(
  diff: string,
  files?: FullFile[],
): ValidateCommitResult {
  if (!diff.trim() && (!files || files.length === 0)) return { ok: true };

  const diffFiles = parseDiff(diff);

  for (const file of diffFiles) {
    // Check allowed paths
    if (!isAllowedPath(file.path)) {
      logger.warn('commit_rejected_path', { path: file.path });
      return { ok: false, reason: `File "${file.path}" is not in allowed paths under .ax/` };
    }

    // Check size limits
    const maxSize = getMaxSize(file.path);
    if (file.addedContent.length > maxSize) {
      logger.warn('commit_rejected_size', { path: file.path, size: file.addedContent.length, max: maxSize });
      return { ok: false, reason: `File "${file.path}" exceeds size limit (${file.addedContent.length} > ${maxSize})` };
    }
  }

  // Frontmatter schema check for SKILL.md files. Relies on the sidecar
  // sending the full file content — if `files` is empty we skip, matching
  // legacy behavior (diff-only callers still pass path+size checks above).
  for (const file of files ?? []) {
    if (!SKILL_MD_RE.test(file.path)) continue;
    const parsed = parseSkillFile(file.content);
    if (!parsed.ok) {
      logger.warn('commit_rejected_frontmatter', { path: file.path, error: parsed.error });
      return {
        ok: false,
        reason: `${file.path}: ${parsed.error}`,
      };
    }
  }

  return { ok: true };
}
