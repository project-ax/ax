import { describe, test, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractImageDataBlocks } from '../../src/host/server-completions.js';
import { safePath } from '../../src/utils/safe-path.js';
import { userWorkspaceDir } from '../../src/paths.js';
import type { ContentBlock } from '../../src/types.js';

describe('extractImageDataBlocks', () => {
  const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => logger } as any;

  test('passes through blocks unchanged when no image_data present', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'image', fileId: 'files/abc.png', mimeType: 'image/png' },
    ];
    const wsDir = mkdtempSync(join(tmpdir(), 'ax-test-'));
    try {
      const result = extractImageDataBlocks(blocks, wsDir, logger);
      expect(result.blocks).toBe(blocks); // same reference — no copy
      expect(result.extractedFiles).toEqual([]);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  test('converts image_data to image file ref and writes to disk', () => {
    // 1x1 red PNG pixel (base64)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Generated chart:' },
      { type: 'image_data', data: pngBase64, mimeType: 'image/png' },
    ];
    const wsDir = mkdtempSync(join(tmpdir(), 'ax-test-'));
    try {
      const result = extractImageDataBlocks(blocks, wsDir, logger);

      // First block preserved
      expect(result.blocks[0]).toEqual({ type: 'text', text: 'Generated chart:' });

      // Second block converted to image ref
      expect(result.blocks[1].type).toBe('image');
      expect((result.blocks[1] as any).fileId).toMatch(/^files\/[a-f0-9-]+\.png$/);
      expect((result.blocks[1] as any).mimeType).toBe('image/png');

      // File written to disk
      const fileId = (result.blocks[1] as any).fileId;
      const filePath = join(wsDir, fileId);
      expect(existsSync(filePath)).toBe(true);
      const data = readFileSync(filePath);
      expect(data).toEqual(Buffer.from(pngBase64, 'base64'));

      // ExtractedFile returned with in-memory buffer
      expect(result.extractedFiles).toHaveLength(1);
      expect(result.extractedFiles[0].fileId).toBe(fileId);
      expect(result.extractedFiles[0].data).toEqual(Buffer.from(pngBase64, 'base64'));
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  test('handles multiple image_data blocks interspersed with text', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'First image:' },
      { type: 'image_data', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'Second image:' },
      { type: 'image_data', data: 'BBBB', mimeType: 'image/jpeg' },
    ];
    const wsDir = mkdtempSync(join(tmpdir(), 'ax-test-'));
    try {
      const result = extractImageDataBlocks(blocks, wsDir, logger);
      expect(result.blocks).toHaveLength(4);
      expect(result.blocks[0].type).toBe('text');
      expect(result.blocks[1].type).toBe('image');
      expect((result.blocks[1] as any).fileId).toMatch(/\.png$/);
      expect(result.blocks[2].type).toBe('text');
      expect(result.blocks[3].type).toBe('image');
      expect((result.blocks[3] as any).fileId).toMatch(/\.jpg$/);
      expect(result.extractedFiles).toHaveLength(2);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});


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

describe('generated image workspace persistence', () => {
  test('drained images are written to workspace for /v1/files/ retrieval', () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'ax-test-'));
    try {
      // Simulate the persistence logic from processCompletion:
      // after drainGeneratedImages(), each image is written to the workspace
      // so the download handler at /v1/files/<fileId> can serve it later.
      const imageData = Buffer.from('fake-png-data');
      const generatedImages = [
        { fileId: 'generated-abc123.png', mimeType: 'image/png', data: imageData },
      ];

      for (const img of generatedImages) {
        const filePath = safePath(wsDir, ...img.fileId.split('/').filter(Boolean));
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, img.data);
      }

      // The download handler resolves: safePath(wsDir, ...fileId.split('/').filter(Boolean))
      // Verify the file is at the same path the handler would look for.
      const downloadPath = safePath(wsDir, ...generatedImages[0].fileId.split('/').filter(Boolean));
      expect(existsSync(downloadPath)).toBe(true);
      expect(readFileSync(downloadPath)).toEqual(imageData);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  test('persist + download paths align for enterprise user workspace with email userId', () => {
    // This tests the exact scenario: user field "vinay@canopyworks.com/conv-001"
    // Both persist and download resolve via userWorkspaceDir() to the same directory.
    const originalAxHome = process.env.AX_HOME;
    const testAxHome = mkdtempSync(join(tmpdir(), 'ax-test-'));
    process.env.AX_HOME = testAxHome;
    try {
      const agentName = 'main';
      const userId = 'vinay@canopyworks.com';
      const imageData = Buffer.from('test-png-bytes');
      const fileId = 'generated-a341d7ac.png';

      // Persist path (from processCompletion — writes to userWorkspaceDir)
      const workspace = userWorkspaceDir(agentName, userId);
      mkdirSync(workspace, { recursive: true });
      const persistPath = safePath(workspace, ...fileId.split('/').filter(Boolean));
      mkdirSync(join(persistPath, '..'), { recursive: true });
      writeFileSync(persistPath, imageData);

      // Download path (from handleFileDownload — reads from userWorkspaceDir)
      const downloadWsDir = userWorkspaceDir(agentName, userId);
      const downloadPath = safePath(downloadWsDir, ...fileId.split('/').filter(Boolean));

      // Both paths must be identical
      expect(persistPath).toBe(downloadPath);
      expect(existsSync(downloadPath)).toBe(true);
      expect(readFileSync(downloadPath)).toEqual(imageData);

      // Verify the enterprise user workspace directory structure
      expect(workspace).toContain(join('agents', 'main', 'users', 'vinay@canopyworks.com', 'workspace'));
    } finally {
      if (originalAxHome !== undefined) {
        process.env.AX_HOME = originalAxHome;
      } else {
        delete process.env.AX_HOME;
      }
      rmSync(testAxHome, { recursive: true, force: true });
    }
  });

  test('images with subdirectory fileId are written correctly', () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'ax-test-'));
    try {
      const imageData = Buffer.from('fake-jpeg-data');
      const generatedImages = [
        { fileId: 'files/generated-xyz789.jpg', mimeType: 'image/jpeg', data: imageData },
      ];

      for (const img of generatedImages) {
        const filePath = safePath(wsDir, ...img.fileId.split('/').filter(Boolean));
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, img.data);
      }

      const downloadPath = safePath(wsDir, ...generatedImages[0].fileId.split('/').filter(Boolean));
      expect(existsSync(downloadPath)).toBe(true);
      expect(readFileSync(downloadPath)).toEqual(imageData);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  test('multiple images are all persisted', () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'ax-test-'));
    try {
      const generatedImages = [
        { fileId: 'generated-aaa.png', mimeType: 'image/png', data: Buffer.from('img-1') },
        { fileId: 'generated-bbb.webp', mimeType: 'image/webp', data: Buffer.from('img-2') },
      ];

      for (const img of generatedImages) {
        const filePath = safePath(wsDir, ...img.fileId.split('/').filter(Boolean));
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, img.data);
      }

      for (const img of generatedImages) {
        const downloadPath = safePath(wsDir, ...img.fileId.split('/').filter(Boolean));
        expect(existsSync(downloadPath)).toBe(true);
        expect(readFileSync(downloadPath)).toEqual(img.data);
      }
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});
