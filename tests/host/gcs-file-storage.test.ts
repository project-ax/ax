import { describe, test, expect } from 'vitest';
import { createGcsFileStorage } from '../../src/host/gcs-file-storage.js';

/** Mock GCS bucket that stores files in memory. */
function mockBucket() {
  const store = new Map<string, { content: Buffer; metadata?: Record<string, string> }>();
  let lastSignedUrlConfig: any = null;
  return {
    store,
    get lastSignedUrlConfig() { return lastSignedUrlConfig; },
    file(name: string) {
      return {
        save(content: Buffer, opts?: { metadata?: { metadata?: Record<string, string> }; contentType?: string }) {
          store.set(name, { content, metadata: opts?.metadata?.metadata });
          return Promise.resolve();
        },
        exists() {
          return Promise.resolve([store.has(name)]);
        },
        getSignedUrl(config: any) {
          lastSignedUrlConfig = config;
          return Promise.resolve([`https://storage.googleapis.com/test-bucket/${name}?signed=true&expires=${config.expires}`]);
        },
        download() {
          const entry = store.get(name);
          return Promise.resolve([entry?.content ?? Buffer.alloc(0)]);
        },
      };
    },
  };
}

describe('GcsFileStorage', () => {
  test('upload stores file in bucket', async () => {
    const bucket = mockBucket();
    const gcs = createGcsFileStorage(bucket as any, 'workspace/');

    await gcs.upload('files/abc.pdf', Buffer.from('pdf-data'), 'application/pdf', 'report.pdf');

    expect(bucket.store.has('workspace/files/abc.pdf')).toBe(true);
    expect(bucket.store.get('workspace/files/abc.pdf')!.content).toEqual(Buffer.from('pdf-data'));
  });

  test('getSignedUrl returns URL with filename disposition', async () => {
    const bucket = mockBucket();
    const gcs = createGcsFileStorage(bucket as any, 'workspace/');

    await gcs.upload('files/abc.pdf', Buffer.from('pdf-data'), 'application/pdf', 'report.pdf');
    const url = await gcs.getSignedUrl('files/abc.pdf', 'report.pdf');

    expect(url).toContain('storage.googleapis.com');
    expect(url).toContain('signed=true');
    // Verify filename is included in the signed URL config
    expect(bucket.lastSignedUrlConfig.responseDisposition).toContain('report.pdf');
  });

  test('exists returns true for uploaded file', async () => {
    const bucket = mockBucket();
    const gcs = createGcsFileStorage(bucket as any, 'workspace/');

    await gcs.upload('files/abc.pdf', Buffer.from('pdf-data'), 'application/pdf', 'report.pdf');
    expect(await gcs.exists('files/abc.pdf')).toBe(true);
    expect(await gcs.exists('files/nonexistent.pdf')).toBe(false);
  });

  test('handles empty prefix', async () => {
    const bucket = mockBucket();
    const gcs = createGcsFileStorage(bucket as any, '');

    await gcs.upload('files/abc.pdf', Buffer.from('data'), 'application/pdf', 'test.pdf');
    expect(bucket.store.has('files/abc.pdf')).toBe(true);
  });

  test('download returns uploaded file content', async () => {
    const bucket = mockBucket();
    const gcs = createGcsFileStorage(bucket as any, 'workspace/');

    const data = Buffer.from('test-content');
    await gcs.upload('files/test.bin', data, 'application/octet-stream', 'test.bin');
    const downloaded = await gcs.download('files/test.bin');
    expect(downloaded).toEqual(data);
  });
});
