// tests/providers/memory/memoryfs/prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  buildSummaryPromptWithRefs,
  buildPatchPrompt,
  parsePatchResponse,
} from '../../../../src/providers/memory/memoryfs/prompts.js';

describe('buildSummaryPrompt', () => {
  it('includes category name and target length', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '',
      newItems: ['Prefers TypeScript', 'Uses vim'],
      targetLength: 400,
    });
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('400');
    expect(prompt).toContain('Prefers TypeScript');
    expect(prompt).toContain('Uses vim');
  });

  it('includes original content when provided', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '# preferences\n## Editor\n- Uses emacs\n',
      newItems: ['Uses vim now'],
      targetLength: 400,
    });
    expect(prompt).toContain('Uses emacs');
    expect(prompt).toContain('Uses vim now');
  });
});

describe('buildSummaryPromptWithRefs', () => {
  it('includes item IDs for ref citations', () => {
    const prompt = buildSummaryPromptWithRefs({
      category: 'preferences',
      originalContent: '',
      newItemsWithIds: [
        { refId: 'a1b2c3', content: 'Prefers TypeScript' },
        { refId: 'd4e5f6', content: 'Uses vim' },
      ],
      targetLength: 400,
    });
    expect(prompt).toContain('[a1b2c3]');
    expect(prompt).toContain('[d4e5f6]');
    expect(prompt).toContain('[ref:');
  });
});

describe('buildPatchPrompt', () => {
  it('formats add operation', () => {
    const prompt = buildPatchPrompt({
      category: 'preferences',
      originalContent: '# preferences\n## Editor\n- Uses vim\n',
      updateContent: 'This memory content is newly added:\nPrefers dark mode',
    });
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('Uses vim');
    expect(prompt).toContain('newly added');
  });
});

describe('parsePatchResponse', () => {
  it('parses need_update true response', () => {
    const result = parsePatchResponse('{"need_update": true, "updated_content": "# preferences\\n## Editor\\n- Uses vim\\n- Prefers dark mode\\n"}');
    expect(result.needUpdate).toBe(true);
    expect(result.updatedContent).toContain('dark mode');
  });

  it('parses need_update false response', () => {
    const result = parsePatchResponse('{"need_update": false, "updated_content": ""}');
    expect(result.needUpdate).toBe(false);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parsePatchResponse('not json');
    expect(result.needUpdate).toBe(false);
  });
});
