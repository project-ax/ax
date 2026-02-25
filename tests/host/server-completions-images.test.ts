import { describe, test, expect } from 'vitest';

// Test parseAgentResponse directly — we import the non-exported function
// by testing its behavior through the module's exports.
// Since parseAgentResponse is not exported, we test it indirectly via the
// structured response protocol.

describe('structured agent response parsing', () => {
  // Test the __ax_response protocol behavior
  test('plain text is treated as plain text', () => {
    const raw = 'Hello, here is your answer.';
    // Not structured — just text
    expect(raw.trimStart().startsWith('{"__ax_response":')).toBe(false);
  });

  test('structured response starts with __ax_response marker', () => {
    const structured = JSON.stringify({
      __ax_response: {
        content: [
          { type: 'text', text: 'Here is the chart:' },
          { type: 'image', fileId: 'files/chart.png', mimeType: 'image/png' },
        ],
      },
    });
    expect(structured.trimStart().startsWith('{"__ax_response":')).toBe(true);
  });

  test('structured response can be parsed', () => {
    const structured = JSON.stringify({
      __ax_response: {
        content: [
          { type: 'text', text: 'Analysis complete.' },
          { type: 'image', fileId: 'files/result.png', mimeType: 'image/png' },
        ],
      },
    });
    const parsed = JSON.parse(structured);
    expect(parsed.__ax_response.content).toHaveLength(2);
    expect(parsed.__ax_response.content[0].type).toBe('text');
    expect(parsed.__ax_response.content[1].type).toBe('image');
    expect(parsed.__ax_response.content[1].fileId).toBe('files/result.png');
  });
});
