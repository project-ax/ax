/**
 * GCS file storage — upload files and generate signed download URLs.
 *
 * Uses the same bucket/prefix as the workspace provider.
 * When GCS is not configured, callers fall back to local disk.
 */

export interface GcsFileStorage {
  upload(fileId: string, buffer: Buffer, mimeType: string, filename: string): Promise<void>;
  getSignedUrl(fileId: string, filename: string): Promise<string>;
  exists(fileId: string): Promise<boolean>;
  download(fileId: string): Promise<Buffer>;
  close(): Promise<void>;
}

function normalizePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

export function createGcsFileStorage(bucket: any, prefix: string): GcsFileStorage {
  const norm = normalizePrefix(prefix);

  return {
    async upload(fileId, buffer, mimeType, filename) {
      const key = `${norm}${fileId}`;
      await bucket.file(key).save(buffer, {
        contentType: mimeType,
        metadata: { metadata: { originalFilename: filename } },
      });
    },

    async getSignedUrl(fileId, filename) {
      const key = `${norm}${fileId}`;
      // Sanitize filename for Content-Disposition: strip CR/LF, escape quotes
      const safe = filename.replace(/[\r\n]/g, '').replace(/["\\]/g, '\\$&');
      const encoded = encodeURIComponent(filename);
      const [url] = await bucket.file(key).getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
        responseDisposition: `inline; filename="${safe}"; filename*=UTF-8''${encoded}`,
        responseType: undefined, // use stored content-type
      });
      return url;
    },

    async exists(fileId) {
      const key = `${norm}${fileId}`;
      const [exists] = await bucket.file(key).exists();
      return exists;
    },

    async download(fileId) {
      const key = `${norm}${fileId}`;
      const [content] = await bucket.file(key).download();
      return content;
    },

    async close() {
      // No-op: GCS client does not hold persistent connections that need explicit teardown.
    },
  };
}
