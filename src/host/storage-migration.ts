/**
 * One-time migration: import identity files and skills from filesystem
 * into the DocumentStore (database). After migration, the filesystem
 * files become inert — the DB is the source of truth.
 *
 * Migration runs once per agent, gated by a 'migrated_storage_v1' flag
 * in the 'migration_flags' collection.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { agentIdentityFilesDir, agentIdentityDir, agentSkillsDir, agentUserDir, userSkillsDir } from '../paths.js';
import { getLogger } from '../logger.js';
import type { DocumentStore } from '../providers/storage/types.js';

const logger = getLogger().child({ component: 'storage-migration' });

/**
 * Recursively walk a directory, returning relative .md file paths.
 */
function walkDir(dir: string, root?: string): string[] {
  const base = root ?? dir;
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...walkDir(fullPath, base));
        } else if (entry.endsWith('.md')) {
          results.push(relative(base, fullPath));
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* directory doesn't exist or is unreadable */ }
  return results;
}

/**
 * Migrate a single agent's identity files and skills from filesystem to DB.
 */
async function migrateAgent(documents: DocumentStore, agentId: string): Promise<void> {
  let count = 0;

  // 1. Import identity files from agentIdentityFilesDir
  const identityDir = agentIdentityFilesDir(agentId);
  if (existsSync(identityDir)) {
    const identityFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
    for (const file of identityFiles) {
      const filePath = join(identityDir, file);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          if (content.trim()) {
            await documents.put('identity', `${agentId}/${file}`, content);
            count++;
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  // 2. Import USER_BOOTSTRAP.md from config dir
  const configDir = agentIdentityDir(agentId);
  if (existsSync(configDir)) {
    const ubPath = join(configDir, 'USER_BOOTSTRAP.md');
    if (existsSync(ubPath)) {
      try {
        const content = readFileSync(ubPath, 'utf-8');
        if (content.trim()) {
          await documents.put('identity', `${agentId}/USER_BOOTSTRAP.md`, content);
          count++;
        }
      } catch { /* skip */ }
    }
  }

  // 3. Import agent-level skills (recursively, preserving subdirectory structure)
  const skillsDir = agentSkillsDir(agentId);
  if (existsSync(skillsDir)) {
    const skillFiles = walkDir(skillsDir);
    for (const relPath of skillFiles) {
      try {
        const content = readFileSync(join(skillsDir, relPath), 'utf-8');
        if (content.trim()) {
          // Remove .md extension from key? No — keep it for consistency with filesystem
          await documents.put('skills', `${agentId}/${relPath}`, content);
          count++;
        }
      } catch { /* skip */ }
    }
  }

  // 4. Import per-user files (USER.md and user skills)
  const agentDirPath = join(configDir, '..'); // ~/.ax/agents/<agentId>/
  const usersDir = join(agentDirPath, 'users');
  if (existsSync(usersDir)) {
    try {
      const userDirs = readdirSync(usersDir);
      for (const userId of userDirs) {
        const userDir = join(usersDir, userId);
        try {
          if (!statSync(userDir).isDirectory()) continue;
        } catch { continue; }

        // USER.md
        const userMdPath = join(userDir, 'USER.md');
        if (existsSync(userMdPath)) {
          try {
            const content = readFileSync(userMdPath, 'utf-8');
            if (content.trim()) {
              await documents.put('identity', `${agentId}/users/${userId}/USER.md`, content);
              count++;
            }
          } catch { /* skip */ }
        }

        // User-level skills
        const uSkillsDir = join(userDir, 'skills');
        if (existsSync(uSkillsDir)) {
          const uSkillFiles = walkDir(uSkillsDir);
          for (const relPath of uSkillFiles) {
            try {
              const content = readFileSync(join(uSkillsDir, relPath), 'utf-8');
              if (content.trim()) {
                await documents.put('skills', `${agentId}/users/${userId}/${relPath}`, content);
                count++;
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip unreadable users dir */ }
  }

  logger.info('agent_migrated', { agentId, documentsImported: count });
}

/**
 * Run storage migration for the given agent names.
 * Checks for a 'migrated_storage_v1' flag — if present, migration is skipped.
 * After migration, the flag is set to prevent re-running.
 */
export async function runStorageMigration(
  documents: DocumentStore,
  agentNames: string[],
): Promise<void> {
  // Check if already migrated
  const flag = await documents.get('migration_flags', 'migrated_storage_v1');
  if (flag) {
    logger.debug('migration_skipped', { reason: 'already_migrated' });
    return;
  }

  logger.info('migration_start', { agents: agentNames });

  for (const agentName of agentNames) {
    try {
      await migrateAgent(documents, agentName);
    } catch (err) {
      logger.warn('migration_agent_failed', { agentName, error: (err as Error).message });
    }
  }

  // Set migration flag
  await documents.put('migration_flags', 'migrated_storage_v1', new Date().toISOString());
  logger.info('migration_complete');
}
