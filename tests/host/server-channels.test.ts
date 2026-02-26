import { describe, test, expect, vi } from 'vitest';
import { buildContentWithAttachments } from '../../src/host/server-channels.js';
import type { Attachment } from '../../src/providers/channel/types.js';
import type { ContentBlock } from '../../src/types.js';

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => logger } as any;

describe('buildContentWithAttachments', () => {
  test('uses downloadFn instead of plain fetch for image attachments', async () => {
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const downloadFn = vi.fn().mockResolvedValue(imageData);

    const attachments: Attachment[] = [{
      filename: 'photo.png',
      mimeType: 'image/png',
      size: 4,
      url: 'https://files.slack.com/files-pri/T01-F01/photo.png',
    }];

    const result = await buildContentWithAttachments('analyze this', attachments, logger, downloadFn);

    expect(downloadFn).toHaveBeenCalledWith(attachments[0]);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'analyze this' });
    expect(blocks[1]).toEqual({
      type: 'image_data',
      data: imageData.toString('base64'),
      mimeType: 'image/png',
    });
  });

  test('falls back to plain fetch when downloadFn is not provided', async () => {
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageData.buffer),
    }) as any;

    try {
      const attachments: Attachment[] = [{
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        url: 'https://example.com/photo.png',
      }];

      const result = await buildContentWithAttachments('check this', attachments, logger);

      expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/photo.png');
      const blocks = result as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[1].type).toBe('image_data');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('falls back to plain fetch when downloadFn returns undefined', async () => {
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const downloadFn = vi.fn().mockResolvedValue(undefined);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageData.buffer),
    }) as any;

    try {
      const attachments: Attachment[] = [{
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        url: 'https://example.com/photo.png',
      }];

      const result = await buildContentWithAttachments('img', attachments, logger, downloadFn);

      expect(downloadFn).toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalled();
      const blocks = result as ContentBlock[];
      expect(blocks[1].type).toBe('image_data');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('returns plain text when no image attachments', async () => {
    const attachments: Attachment[] = [{
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 1000,
      url: 'https://example.com/doc.pdf',
    }];

    const result = await buildContentWithAttachments('see the doc', attachments, logger);

    expect(result).toBe('see the doc');
  });

  test('returns plain text when all downloads fail', async () => {
    const downloadFn = vi.fn().mockResolvedValue(undefined);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as any;

    try {
      const attachments: Attachment[] = [{
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        url: 'https://example.com/photo.png',
      }];

      const result = await buildContentWithAttachments('img', attachments, logger, downloadFn);

      expect(result).toBe('img');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
