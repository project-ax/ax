/**
 * Readonly skill store backed by DocumentStore.
 *
 * Skills are stored as documents in the 'skills' collection with keys
 * like '<agentName>/<skillPath>'. The propose() method writes directly
 * to DocumentStore (auto-approve).
 */
import { randomUUID } from 'node:crypto';
import type { SkillStoreProvider, SkillMeta, SkillProposal, ProposalResult, SkillLogEntry, LogOptions } from './types.js';
import type { Config } from '../../types.js';
import type { StorageProvider } from '../storage/types.js';

export interface CreateOptions {
  screener?: unknown;
  storage?: StorageProvider;
}

export async function create(config: Config, _name?: string, opts?: CreateOptions): Promise<SkillStoreProvider> {
  const agentName = config.agent_name ?? 'main';
  const documents = opts?.storage?.documents;

  if (!documents) {
    throw new Error('readonly skills provider requires storage provider with DocumentStore');
  }

  return {
    async list(): Promise<SkillMeta[]> {
      const allKeys = await documents.list('skills');
      const prefix = `${agentName}/`;
      const agentKeys = allKeys.filter(k => k.startsWith(prefix) && !k.includes('/users/'));

      // Deduplicate: directory-based skills (foo/SKILL.md) should appear
      // as name "foo", not "foo/SKILL". Track seen names to avoid duplicates
      // if both foo.md and foo/SKILL.md exist (file-based takes precedence).
      const seen = new Set<string>();
      const results: SkillMeta[] = [];
      for (const k of agentKeys) {
        const relPath = k.slice(prefix.length);
        let name: string;
        if (relPath.endsWith('/SKILL.md')) {
          // Directory-based skill: "deploy/SKILL.md" → name "deploy"
          name = relPath.replace(/\/SKILL\.md$/, '');
        } else {
          // File-based skill: "deploy.md" → name "deploy"
          name = relPath.replace(/\.md$/, '');
        }
        if (!seen.has(name)) {
          seen.add(name);
          results.push({ name, path: relPath });
        }
      }
      return results;
    },

    async read(name: string): Promise<string> {
      // name could be a flat name ('deploy') or a path ('ops/deploy')
      // Try with .md suffix first, then directory-based SKILL.md, then without suffix
      const keyWithMd = `${agentName}/${name}.md`;
      let content = await documents.get('skills', keyWithMd);
      if (content) return content;

      // Try directory-based: name/SKILL.md
      const keyDirSkill = `${agentName}/${name}/SKILL.md`;
      content = await documents.get('skills', keyDirSkill);
      if (content) return content;

      const key = `${agentName}/${name}`;
      content = await documents.get('skills', key);
      if (content) return content;

      throw new Error(`Skill not found: ${name}`);
    },

    async propose(proposal: SkillProposal): Promise<ProposalResult> {
      const key = `${agentName}/${proposal.skill}.md`;
      await documents.put('skills', key, proposal.content);
      return { id: randomUUID(), verdict: 'AUTO_APPROVE', reason: 'Applied to document store' };
    },

    async approve(_proposalId: string): Promise<void> {
      // No-op: proposals are auto-applied in propose()
    },

    async reject(_proposalId: string): Promise<void> {
      // No-op: proposals are auto-applied in propose()
    },

    async revert(_commitId: string): Promise<void> {
      throw new Error('Revert not supported in readonly provider.');
    },

    async log(_opts?: LogOptions): Promise<SkillLogEntry[]> {
      return [];
    },
  };
}
