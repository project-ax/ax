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

// Stub paths.ts to use temp directory for workspace
let tmpDir: string;

vi.mock('../../src/paths.js', () => ({
  userWorkspaceDir: (agent: string, user: string) => join(tmpDir, 'agents', agent, 'users', user, 'workspace'),
}));

// Helper: create a mock request
function mockRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): any {
  const req: any = {
    method,
    url,
    headers,
  };
  if (body) {
    // Make it async iterable for readBinaryBody
    req[Symbol.asyncIterator] = async function* () {
      yield body;
    };
  } else {
    req[Symbol.asyncIterator] = async function* () {};
  }
  return req;
}

// Helper: create a mock response
function mockResponse(): any {
  const res: any = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  };
  return res;
}

describe('File upload/download API', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-files-test-'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('handleFileUpload', () => {
    test('uploads a PNG image and returns fileId', async () => {
      const imageData = Buffer.from('fake-png-data');
      const req = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
        'content-type': 'image/png',
      }, imageData);
      const res = mockResponse();

      await handleFileUpload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'application/json',
      }));

      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.fileId).toMatch(/^files\/[a-f0-9-]+\.png$/);
      expect(responseBody.mimeType).toBe('image/png');
      expect(responseBody.size).toBe(imageData.length);

      // Verify file was actually written to disk
      const wsDir = join(tmpDir, 'agents', 'main', 'users', 'testuser', 'workspace');
      const filePath = join(wsDir, responseBody.fileId);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(imageData);
    });

    test('uploads a JPEG image', async () => {
      const imageData = Buffer.from('fake-jpeg-data');
      const req = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
        'content-type': 'image/jpeg',
      }, imageData);
      const res = mockResponse();

      await handleFileUpload(req, res);

      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.fileId).toMatch(/\.jpg$/);
      expect(responseBody.mimeType).toBe('image/jpeg');
    });

    test('rejects missing agent/user params', async () => {
      const req = mockRequest('POST', '/v1/files', {
        'content-type': 'image/png',
      }, Buffer.from('data'));
      const res = mockResponse();

      await handleFileUpload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('rejects unsupported MIME type', async () => {
      const req = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
        'content-type': 'application/x-executable',
      }, Buffer.from('data'));
      const res = mockResponse();

      await handleFileUpload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('rejects empty body', async () => {
      const req = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
        'content-type': 'image/png',
      });
      const res = mockResponse();

      await handleFileUpload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
  });

  describe('handleFileDownload', () => {
    test('downloads an uploaded file', async () => {
      // First upload
      const imageData = Buffer.from('test-image-content');
      const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
        'content-type': 'image/png',
      }, imageData);
      const uploadRes = mockResponse();
      await handleFileUpload(uploadReq, uploadRes);

      const { fileId } = JSON.parse(uploadRes.end.mock.calls[0][0]);

      // Now download
      const downloadReq = mockRequest('GET', `/v1/files/${fileId}?agent=main&user=testuser`, {});
      const downloadRes = mockResponse();
      await handleFileDownload(downloadReq, downloadRes);

      expect(downloadRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=3600',
      }));
      expect(downloadRes.end.mock.calls[0][0]).toEqual(imageData);
    });

    test('returns 404 for non-existent file', async () => {
      const req = mockRequest('GET', '/v1/files/files/nonexistent.png?agent=main&user=testuser', {});
      const res = mockResponse();

      await handleFileDownload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('rejects missing file ID', async () => {
      const req = mockRequest('GET', '/v1/files/?agent=main&user=testuser', {});
      const res = mockResponse();

      await handleFileDownload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('downloads by fileId alone using FileStore lookup', async () => {
      // Upload a file with explicit agent/user
      const imageData = Buffer.from('lookup-test-image');
      const uploadReq = mockRequest('POST', '/v1/files?agent=main&user=testuser', {
        'content-type': 'image/png',
      }, imageData);
      const uploadRes = mockResponse();
      await handleFileUpload(uploadReq, uploadRes);

      const { fileId } = JSON.parse(uploadRes.end.mock.calls[0][0]);

      // Register in FileStore
      const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files.db') });
      await runMigrations(db, filesMigrations);
      const fileStore = new FileStore(db);
      try {
        await fileStore.register(fileId, 'main', 'testuser', 'image/png');

        // Download WITHOUT agent/user params — should resolve via FileStore
        const downloadReq = mockRequest('GET', `/v1/files/${fileId}`, {});
        const downloadRes = mockResponse();
        await handleFileDownload(downloadReq, downloadRes, { fileStore });

        expect(downloadRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
          'Content-Type': 'image/png',
        }));
        expect(downloadRes.end.mock.calls[0][0]).toEqual(imageData);
      } finally {
        await fileStore.close();
      }
    });

    test('returns 404 when fileId not in FileStore and no agent/user params', async () => {
      const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files.db') });
      await runMigrations(db, filesMigrations);
      const fileStore = new FileStore(db);
      try {
        const req = mockRequest('GET', '/v1/files/nonexistent.png', {});
        const res = mockResponse();
        await handleFileDownload(req, res, { fileStore });

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      } finally {
        await fileStore.close();
      }
    });
  });

  describe('GCS mode', () => {
    function mockGcs(): GcsFileStorage & { stored: Map<string, Buffer> } {
      const stored = new Map<string, Buffer>();
      return {
        stored,
        upload: vi.fn(async (fileId: string, buffer: Buffer) => { stored.set(fileId, buffer); }),
        getSignedUrl: vi.fn(async (fileId: string) => `https://gcs.example.com/${fileId}?signed=1`),
        exists: vi.fn(async (fileId: string) => stored.has(fileId)),
        download: vi.fn(async (fileId: string) => stored.get(fileId) ?? Buffer.alloc(0)),
      };
    }

    test('upload stores file in GCS, not local disk', async () => {
      const gcs = mockGcs();
      const imageData = Buffer.from('gcs-test-image');
      const req = mockRequest('POST', '/v1/files?agent=main&user=testuser&filename=photo.png', {
        'content-type': 'image/png',
      }, imageData);
      const res = mockResponse();

      await handleFileUpload(req, res, { gcsFileStorage: gcs });

      expect(gcs.upload).toHaveBeenCalled();
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.fileId).toMatch(/^files\//);
      expect(responseBody.filename).toBe('photo.png');
    });

    test('download returns 302 redirect to signed URL', async () => {
      const gcs = mockGcs();
      const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files-gcs.db') });
      await runMigrations(db, filesMigrations);
      const fileStore = new FileStore(db);
      try {
        await fileStore.register('files/test.png', 'main', 'testuser', 'image/png', 'test.png');
        gcs.stored.set('files/test.png', Buffer.from('data'));

        const req = mockRequest('GET', '/v1/files/files/test.png', {});
        const downloadRes = mockResponse();
        await handleFileDownload(req, downloadRes, { fileStore, gcsFileStorage: gcs });

        expect(downloadRes.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({
          Location: expect.stringContaining('gcs.example.com'),
        }));
      } finally {
        await fileStore.close();
      }
    });

    test('upload accepts PDF files', async () => {
      const gcs = mockGcs();
      const pdfData = Buffer.from('fake-pdf-data');
      const req = mockRequest('POST', '/v1/files?agent=main&user=testuser&filename=report.pdf', {
        'content-type': 'application/pdf',
      }, pdfData);
      const res = mockResponse();

      await handleFileUpload(req, res, { gcsFileStorage: gcs });

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.mimeType).toBe('application/pdf');
    });
  });
});
