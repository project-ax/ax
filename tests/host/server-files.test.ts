import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleFileUpload, handleFileDownload } from '../../src/host/server-files.js';

// Stub paths.ts to use temp directory for workspace
let tmpDir: string;

vi.mock('../../src/paths.js', () => ({
  isValidSessionId: (id: string) => /^[a-zA-Z0-9_.:/-]+$/.test(id) && id.length > 0,
  workspaceDir: (sessionId: string) => join(tmpDir, 'workspaces', sessionId.replace(/:/g, '_')),
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
      const req = mockRequest('POST', '/v1/files?session_id=test:cli:default', {
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
      const wsDir = join(tmpDir, 'workspaces', 'test_cli_default');
      const filePath = join(wsDir, responseBody.fileId);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(imageData);
    });

    test('uploads a JPEG image', async () => {
      const imageData = Buffer.from('fake-jpeg-data');
      const req = mockRequest('POST', '/v1/files?session_id=test:cli:default', {
        'content-type': 'image/jpeg',
      }, imageData);
      const res = mockResponse();

      await handleFileUpload(req, res);

      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.fileId).toMatch(/\.jpg$/);
      expect(responseBody.mimeType).toBe('image/jpeg');
    });

    test('rejects missing session_id', async () => {
      const req = mockRequest('POST', '/v1/files', {
        'content-type': 'image/png',
      }, Buffer.from('data'));
      const res = mockResponse();

      await handleFileUpload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('rejects unsupported MIME type', async () => {
      const req = mockRequest('POST', '/v1/files?session_id=test:cli:default', {
        'content-type': 'application/pdf',
      }, Buffer.from('data'));
      const res = mockResponse();

      await handleFileUpload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('rejects empty body', async () => {
      const req = mockRequest('POST', '/v1/files?session_id=test:cli:default', {
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
      const uploadReq = mockRequest('POST', '/v1/files?session_id=test:cli:default', {
        'content-type': 'image/png',
      }, imageData);
      const uploadRes = mockResponse();
      await handleFileUpload(uploadReq, uploadRes);

      const { fileId } = JSON.parse(uploadRes.end.mock.calls[0][0]);

      // Now download
      const downloadReq = mockRequest('GET', `/v1/files/${fileId}?session_id=test:cli:default`, {});
      const downloadRes = mockResponse();
      await handleFileDownload(downloadReq, downloadRes);

      expect(downloadRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=3600',
      }));
      expect(downloadRes.end.mock.calls[0][0]).toEqual(imageData);
    });

    test('returns 404 for non-existent file', async () => {
      const req = mockRequest('GET', '/v1/files/files/nonexistent.png?session_id=test:cli:default', {});
      const res = mockResponse();

      await handleFileDownload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('rejects missing session_id', async () => {
      const req = mockRequest('GET', '/v1/files/files/test.png', {});
      const res = mockResponse();

      await handleFileDownload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('rejects missing file ID', async () => {
      const req = mockRequest('GET', '/v1/files/?session_id=test:cli:default', {});
      const res = mockResponse();

      await handleFileDownload(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
  });
});
