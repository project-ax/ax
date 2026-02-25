import { describe, test, expect } from 'vitest';
import { parseStdinPayload, historyToPiMessages } from '../../src/agent/runner.js';
import type { ContentBlock } from '../../src/types.js';

describe('agent runner image support', () => {
  describe('parseStdinPayload with structured content', () => {
    test('parses plain text message', () => {
      const payload = parseStdinPayload(JSON.stringify({
        message: 'Hello',
        history: [],
        taintRatio: 0,
        taintThreshold: 1,
        profile: 'balanced',
        sandboxType: 'subprocess',
      }));
      expect(payload.message).toBe('Hello');
    });

    test('parses structured message with image blocks', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', fileId: 'files/abc.png', mimeType: 'image/png' },
      ];
      const payload = parseStdinPayload(JSON.stringify({
        message: blocks,
        history: [],
        taintRatio: 0,
        taintThreshold: 1,
        profile: 'balanced',
        sandboxType: 'subprocess',
      }));
      expect(payload.message).toEqual(blocks);
    });

    test('parses history with structured content', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'See this' },
        { type: 'image', fileId: 'files/photo.jpg', mimeType: 'image/jpeg' },
      ];
      const payload = parseStdinPayload(JSON.stringify({
        message: 'Follow up',
        history: [
          { role: 'user', content: blocks },
          { role: 'assistant', content: 'I can see the image' },
        ],
        taintRatio: 0,
        taintThreshold: 1,
        profile: 'balanced',
        sandboxType: 'subprocess',
      }));
      expect(payload.history[0].content).toEqual(blocks);
      expect(payload.history[1].content).toBe('I can see the image');
    });

    test('falls back to plain text for non-JSON input', () => {
      const payload = parseStdinPayload('just a string');
      expect(payload.message).toBe('just a string');
    });
  });

  describe('historyToPiMessages with structured content', () => {
    test('extracts text from ContentBlock[] user messages', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Describe this' },
        { type: 'image', fileId: 'files/img.png', mimeType: 'image/png' },
      ];
      const messages = historyToPiMessages([
        { role: 'user', content: blocks },
      ]);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect((messages[0] as any).content).toBe('Describe this');
    });

    test('extracts text from ContentBlock[] assistant messages', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Here is my response' },
        { type: 'image', fileId: 'files/chart.png', mimeType: 'image/png' },
      ];
      const messages = historyToPiMessages([
        { role: 'assistant', content: blocks },
      ]);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      // Assistant messages have content as array of {type, text} objects
      expect((messages[0] as any).content[0].text).toBe('Here is my response');
    });

    test('handles plain text messages unchanged', () => {
      const messages = historyToPiMessages([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
      expect(messages).toHaveLength(2);
      expect((messages[0] as any).content).toBe('Hello');
      expect((messages[1] as any).content[0].text).toBe('Hi there');
    });

    test('includes sender prefix for user messages', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Look at this' },
        { type: 'image', fileId: 'files/img.png', mimeType: 'image/png' },
      ];
      const messages = historyToPiMessages([
        { role: 'user', content: blocks, sender: 'alice' },
      ]);
      expect((messages[0] as any).content).toBe('[alice]: Look at this');
    });
  });
});
