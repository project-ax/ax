/**
 * Tests for identity/skills loading from DocumentStore in server-completions.
 */

import { describe, test, expect } from 'vitest';
import { extractSkillMeta } from '../../src/host/server-completions.js';

describe('extractSkillMeta', () => {
  test('extracts name from H1 heading', () => {
    const content = '# Deploy Checklist\nMake sure everything is ready.\n## Steps\n1. Check tests';
    const { name, description } = extractSkillMeta(content, 'deploy');
    expect(name).toBe('Deploy Checklist');
    expect(description).toBe('Make sure everything is ready.');
  });

  test('falls back to last path segment when no H1', () => {
    const content = 'Just some text here.\nMore text.';
    const { name, description } = extractSkillMeta(content, 'main/ops/deploy-checklist');
    expect(name).toBe('deploy-checklist');
    expect(description).toBe('Just some text here.');
  });

  test('strips .md extension from fallback name', () => {
    const content = 'Some content.';
    const { name } = extractSkillMeta(content, 'main/my-skill.md');
    expect(name).toBe('my-skill');
  });

  test('returns "No description" when no non-heading content', () => {
    const content = '# My Skill\n## Section\n### Subsection';
    const { name, description } = extractSkillMeta(content, 'skill');
    expect(name).toBe('My Skill');
    expect(description).toBe('No description');
  });

  test('skips empty lines to find description', () => {
    const content = '# My Skill\n\n\nThis is the real description.\nMore text.';
    const { name, description } = extractSkillMeta(content, 'skill');
    expect(name).toBe('My Skill');
    expect(description).toBe('This is the real description.');
  });

  test('handles empty content', () => {
    const { name, description } = extractSkillMeta('', 'fallback-name');
    expect(name).toBe('fallback-name');
    expect(description).toBe('No description');
  });
});
