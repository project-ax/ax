import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleFileUpload, handleFileDownload } from '../../src/host/server-files.js';
import { FileStore } from '../../src/file-store.js';
import { createKyselyDb } from '../../src/utils/database.js';
import { runMigrations } from '../../src/utils/migrator.js';
import { filesMigrations } from '../../src/migrations/files.js';
import type { GcsFileStorage } from '../../src/host/gcs-file-storage.js';

let tmpDir: string;

vi.mock('../../src/paths.js', () => ({
  userWorkspaceDir: (agent: string, user: string) => join(tmpDir, 'agents', agent, 'users', user, 'workspace'),
}));

function mockRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): any {
  const req: any = { method, url, headers };
  if (body) {
    req[Symbol.asyncIterator] = async function* () { yield body; };
  } else {
    req[Symbol.asyncIterator] = async function* () {};
  }
  return req;
}

function mockResponse(): any {
  return { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
}

function mockGcs(): GcsFileStorage & { stored: Map<string, Buffer> } {
  const stored = new Map<string, Buffer>();
  return {
    stored,
    upload: vi.fn(async (fileId: string, buffer: Buffer) => { stored.set(fileId, buffer); }),
    getSignedUrl: vi.fn(async (fileId: string, filename: string) => `https://gcs.example.com/${fileId}?filename=${filename}&signed=1`),
    exists: vi.fn(async (fileId: string) => stored.has(fileId)),
    download: vi.fn(async (fileId: string) => stored.get(fileId) ?? Buffer.alloc(0)),
  };
}

describe('File attachments E2E', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-files-e2e-'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('upload PDF → download returns 302 to signed URL', async () => {
    const gcs = mockGcs();
    const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files.db') });
    await runMigrations(db, filesMigrations);
    const fileStore = new FileStore(db);

    try {
      // Upload a PDF
      const pdfData = Buffer.from('%PDF-1.4 fake content');
      const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser&filename=report.pdf', {
        'content-type': 'application/pdf',
      }, pdfData);
      const uploadRes = mockResponse();
      await handleFileUpload(uploadReq, uploadRes, { fileStore, gcsFileStorage: gcs });

      expect(uploadRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const uploadBody = JSON.parse(uploadRes.end.mock.calls[0][0]);
      expect(uploadBody.fileId).toMatch(/^files\//);
      expect(uploadBody.mimeType).toBe('application/pdf');
      expect(uploadBody.filename).toBe('report.pdf');

      // Verify GCS upload was called
      expect(gcs.upload).toHaveBeenCalledWith(
        uploadBody.fileId,
        pdfData,
        'application/pdf',
        'report.pdf',
      );

      // Download by fileId → should get 302 redirect
      const downloadReq = mockRequest('GET', `/v1/files/${uploadBody.fileId}`, {});
      const downloadRes = mockResponse();
      await handleFileDownload(downloadReq, downloadRes, { fileStore, gcsFileStorage: gcs });

      expect(downloadRes.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({
        Location: expect.stringContaining('gcs.example.com'),
      }));
    } finally {
      await fileStore.close();
    }
  });

  test('upload image → download returns signed URL', async () => {
    const gcs = mockGcs();
    const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files2.db') });
    await runMigrations(db, filesMigrations);
    const fileStore = new FileStore(db);

    try {
      // Upload an image
      const imageData = Buffer.from('PNG fake image data');
      const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser&filename=photo.png', {
        'content-type': 'image/png',
      }, imageData);
      const uploadRes = mockResponse();
      await handleFileUpload(uploadReq, uploadRes, { fileStore, gcsFileStorage: gcs });

      const { fileId } = JSON.parse(uploadRes.end.mock.calls[0][0]);

      // Download → 302 redirect
      const downloadReq = mockRequest('GET', `/v1/files/${fileId}`, {});
      const downloadRes = mockResponse();
      await handleFileDownload(downloadReq, downloadRes, { fileStore, gcsFileStorage: gcs });

      expect(downloadRes.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({
        Location: expect.stringContaining('signed=1'),
      }));
    } finally {
      await fileStore.close();
    }
  });

  test('local fallback when no GCS', async () => {
    // Upload without GCS
    const imageData = Buffer.from('test-image-local');
    const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
      'content-type': 'image/png',
    }, imageData);
    const uploadRes = mockResponse();
    await handleFileUpload(uploadReq, uploadRes);

    const { fileId } = JSON.parse(uploadRes.end.mock.calls[0][0]);

    // Download serves from local disk (200, not 302)
    const downloadReq = mockRequest('GET', `/v1/files/${fileId}?agent=main&user=testuser`, {});
    const downloadRes = mockResponse();
    await handleFileDownload(downloadReq, downloadRes);

    expect(downloadRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'image/png',
    }));
    expect(downloadRes.end.mock.calls[0][0]).toEqual(imageData);
  });

  test('upload text file succeeds', async () => {
    const gcs = mockGcs();
    const textData = Buffer.from('Hello, world!');
    const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser&filename=notes.txt', {
      'content-type': 'text/plain',
    }, textData);
    const uploadRes = mockResponse();
    await handleFileUpload(uploadReq, uploadRes, { gcsFileStorage: gcs });

    expect(uploadRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse(uploadRes.end.mock.calls[0][0]);
    expect(body.mimeType).toBe('text/plain');
    expect(body.filename).toBe('notes.txt');
  });

  test('upload CSV file succeeds', async () => {
    const gcs = mockGcs();
    const csvData = Buffer.from('a,b,c\n1,2,3');
    const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser&filename=data.csv', {
      'content-type': 'text/csv',
    }, csvData);
    const uploadRes = mockResponse();
    await handleFileUpload(uploadReq, uploadRes, { gcsFileStorage: gcs });

    expect(uploadRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse(uploadRes.end.mock.calls[0][0]);
    expect(body.mimeType).toBe('text/csv');
  });
});
