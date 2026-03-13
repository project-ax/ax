import { describe, test, expect } from 'vitest';
import { createImageHandlers, drainGeneratedImages } from '../../../src/host/ipc-handlers/image.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

describe('image_generate handler', () => {
  function makeCtx(sessionId: string): IPCContext {
    return { sessionId, agentId: 'test-agent' } as IPCContext;
  }

  function makeMockProviders(): ProviderRegistry {
    return {
      image: {
        name: 'mock',
        async generate() {
          return {
            image: Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic bytes
            mimeType: 'image/png',
            text: 'a test image',
            model: 'mock-model',
          };
        },
        async models() { return ['mock-model']; },
      },
    workspace: {
      async mount() { return { paths: {} }; },
      async commit() { return { scopes: {} }; },
      async cleanup() {},
      activeMounts() { return []; },
    },
    } as unknown as ProviderRegistry;
  }

  test('stores generated image in memory and returns fileId', async () => {
    const handlers = createImageHandlers(makeMockProviders());
    const result = await handlers.image_generate(
      { prompt: 'test image', model: 'mock-model' },
      makeCtx('test-session-1'),
    );

    expect(result.fileId).toMatch(/^generated-.+\.png$/);
    expect(result.mimeType).toBe('image/png');
    expect(result.bytes).toBe(4);
    expect(result.text).toBe('a test image');
  });

  test('drainGeneratedImages returns buffered images and clears them', async () => {
    const handlers = createImageHandlers(makeMockProviders());
    const sessionId = 'drain-test-session';

    await handlers.image_generate({ prompt: 'img1' }, makeCtx(sessionId));
    await handlers.image_generate({ prompt: 'img2' }, makeCtx(sessionId));

    const images = drainGeneratedImages(sessionId);
    expect(images).toHaveLength(2);
    expect(images[0].data[0]).toBe(0x89); // PNG magic byte
    expect(images[0].mimeType).toBe('image/png');
    expect(images[1].fileId).toMatch(/^generated-.+\.png$/);

    // Second drain returns empty — images were consumed
    const again = drainGeneratedImages(sessionId);
    expect(again).toHaveLength(0);
  });

  test('drainGeneratedImages returns empty for unknown session', () => {
    const images = drainGeneratedImages('no-such-session');
    expect(images).toHaveLength(0);
  });

  test('throws when no image provider configured', async () => {
    const handlers = createImageHandlers({} as ProviderRegistry);
    await expect(
      handlers.image_generate({ prompt: 'test' }, makeCtx('s')),
    ).rejects.toThrow('No image provider configured');
  });
});
