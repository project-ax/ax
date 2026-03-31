# File Attachments & Artifact Downloads Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add file attachment support (upload/download) for web chat and Slack, with GCS-backed storage and signed URL downloads.

**Architecture:** Extend existing `/v1/files` endpoint to support all file types (not just images), add GCS upload/signed-URL-redirect for persistent storage, provision uploaded files into sandbox workspace so agents can use CLI tools on them. Local disk fallback when GCS is not configured.

**Tech Stack:** TypeScript, `@google-cloud/storage` SDK (already a dependency), Kysely (migrations), assistant-ui (React), Vitest

---

### Task 1: Expand ContentBlock types and MIME type support

**Files:**
- Modify: `src/types.ts:28-37`
- Test: `tests/types.test.ts` (new, simple type-check test)

**Step 1: Add new MIME types and ContentBlock variants to `src/types.ts`**

At line 28, expand `IMAGE_MIME_TYPES` and add `FILE_MIME_TYPES`, then add `file`/`file_data` ContentBlock variants:

```typescript
/** Allowed image MIME types (matches Anthropic vision API). */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

/** Allowed document MIME types for file attachments. */
export const FILE_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export type FileMimeType = typeof FILE_MIME_TYPES[number];

/** All uploadable MIME types (images + documents). */
export const UPLOAD_MIME_TYPES = [...IMAGE_MIME_TYPES, ...FILE_MIME_TYPES] as const;
export type UploadMimeType = typeof UPLOAD_MIME_TYPES[number];

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; fileId: string; mimeType: ImageMimeType }
  | { type: 'image_data'; data: string; mimeType: ImageMimeType }
  | { type: 'file'; fileId: string; mimeType: string; filename: string }
  | { type: 'file_data'; data: string; mimeType: string; filename: string };
```

**Step 2: Run build to verify types compile**

Run: `npm run build`
Expected: PASS (no type errors)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add file/file_data ContentBlock types and document MIME types"
```

---

### Task 2: Add `filename` column to FileStore

**Files:**
- Modify: `src/migrations/files.ts`
- Modify: `src/file-store.ts`
- Test: `tests/file-store.test.ts` (new)

**Step 1: Write the failing test**

Create `tests/file-store.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../src/file-store.js';

describe('FileStore', () => {
  let tmpDir: string;
  let store: FileStore;

  afterEach(async () => {
    await store?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register and lookup with filename', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-filestore-'));
    process.env.AX_DATA_DIR = tmpDir;
    store = await FileStore.create();

    await store.register('files/abc.pdf', 'main', 'user1', 'application/pdf', 'report.pdf');
    const entry = await store.lookup('files/abc.pdf');

    expect(entry).toBeDefined();
    expect(entry!.filename).toBe('report.pdf');
    expect(entry!.mimeType).toBe('application/pdf');
  });

  test('register without filename defaults to empty string', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-filestore-'));
    process.env.AX_DATA_DIR = tmpDir;
    store = await FileStore.create();

    await store.register('files/abc.png', 'main', 'user1', 'image/png');
    const entry = await store.lookup('files/abc.png');

    expect(entry).toBeDefined();
    expect(entry!.filename).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/file-store.test.ts`
Expected: FAIL (filename parameter not accepted / column doesn't exist)

**Step 3: Add migration for `filename` column**

In `src/migrations/files.ts`, add a second migration:

```typescript
export function buildFilesMigrations(dbType: DbDialect): MigrationSet {
  return {
    files_001_initial: {
      // ... existing migration unchanged ...
    },
    files_002_add_filename: {
      async up(db: Kysely<any>) {
        await db.schema
          .alterTable('files')
          .addColumn('filename', 'text', col => col.notNull().defaultTo(''))
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.alterTable('files').dropColumn('filename').execute();
      },
    },
  };
}
```

**Step 4: Update FileStore to accept and return filename**

In `src/file-store.ts`:

Update `FileEntry` interface to add `filename: string`.

Update `register()` signature to accept optional `filename` parameter:
```typescript
async register(fileId: string, agentName: string, userId: string, mimeType: string, filename = ''): Promise<void> {
```

Update the insert values to include `filename`, and the onConflict doUpdateSet to include `filename`.

Update `lookup()` to select and return `filename`:
```typescript
.select(['file_id', 'agent_name', 'user_id', 'mime_type', 'filename', 'created_at'])
```
And in the return object: `filename: (row.filename as string) ?? ''`.

**Step 5: Run test to verify it passes**

Run: `npm test -- --run tests/file-store.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/migrations/files.ts src/file-store.ts tests/file-store.test.ts
git commit -m "feat: add filename column to FileStore"
```

---

### Task 3: Create GCS file storage module

**Files:**
- Create: `src/host/gcs-file-storage.ts`
- Test: `tests/host/gcs-file-storage.test.ts`

**Step 1: Write the failing test**

Create `tests/host/gcs-file-storage.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { createGcsFileStorage, type GcsFileStorage } from '../../src/host/gcs-file-storage.js';

/** Mock GCS bucket that stores files in memory. */
function mockBucket() {
  const store = new Map<string, { content: Buffer; metadata?: Record<string, string> }>();
  return {
    store,
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
          return Promise.resolve([`https://storage.googleapis.com/test-bucket/${name}?signed=true&expires=${config.expires}`]);
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

  test('getSignedUrl returns URL with filename', async () => {
    const bucket = mockBucket();
    const gcs = createGcsFileStorage(bucket as any, 'workspace/');

    await gcs.upload('files/abc.pdf', Buffer.from('pdf-data'), 'application/pdf', 'report.pdf');
    const url = await gcs.getSignedUrl('files/abc.pdf', 'report.pdf');

    expect(url).toContain('storage.googleapis.com');
    expect(url).toContain('signed=true');
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
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/gcs-file-storage.test.ts`
Expected: FAIL (module doesn't exist)

**Step 3: Implement GCS file storage**

Create `src/host/gcs-file-storage.ts`:

```typescript
/**
 * GCS file storage — upload files and generate signed download URLs.
 *
 * Uses the same bucket/prefix as the workspace provider.
 * When GCS is not configured, callers fall back to local disk.
 */

import type { GcsBucketLike } from '../providers/workspace/gcs.js';

export interface GcsFileStorage {
  upload(fileId: string, buffer: Buffer, mimeType: string, filename: string): Promise<void>;
  getSignedUrl(fileId: string, filename: string): Promise<string>;
  exists(fileId: string): Promise<boolean>;
  download(fileId: string): Promise<Buffer>;
}

/** Extended bucket interface with getSignedUrl support. */
export interface GcsFileBucketLike extends GcsBucketLike {
  file(name: string): GcsBucketLike extends { file(name: string): infer F } ? F & {
    exists(): Promise<[boolean]>;
    getSignedUrl(config: {
      action: 'read';
      expires: number;
      responseDisposition?: string;
      responseType?: string;
    }): Promise<[string]>;
    download(): Promise<[Buffer]>;
  } : never;
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
      const [url] = await bucket.file(key).getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
        responseDisposition: `inline; filename="${filename}"`,
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
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/gcs-file-storage.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/gcs-file-storage.ts tests/host/gcs-file-storage.test.ts
git commit -m "feat: add GCS file storage module for upload and signed URL generation"
```

---

### Task 4: Update server-files.ts — GCS upload on POST, signed URL redirect on GET

**Files:**
- Modify: `src/host/server-files.ts`
- Modify: `tests/host/server-files.test.ts`

**Step 1: Write new tests for GCS behavior**

Add to `tests/host/server-files.test.ts`:

```typescript
// Add at top: import for GcsFileStorage mock
// Add new describe block:

describe('GCS mode', () => {
  function mockGcs() {
    const stored = new Map<string, Buffer>();
    return {
      stored,
      upload: vi.fn(async (fileId: string, buffer: Buffer) => { stored.set(fileId, buffer); }),
      getSignedUrl: vi.fn(async (fileId: string, filename: string) => `https://gcs.example.com/${fileId}?signed=1`),
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
```

**Step 2: Run tests to verify new tests fail**

Run: `npm test -- --run tests/host/server-files.test.ts`
Expected: FAIL (gcsFileStorage not in FileDeps, PDF rejected)

**Step 3: Update server-files.ts**

Key changes:
1. Expand `FileDeps` to include optional `gcsFileStorage: GcsFileStorage`
2. Expand `MIME_TO_EXT` to include document types (pdf→.pdf, txt→.txt, csv→.csv, md→.md, json→.json, xlsx→.xlsx)
3. Expand `EXT_TO_MIME` with reverse mappings
4. Change MIME validation from `IMAGE_MIME_TYPES` to `UPLOAD_MIME_TYPES`
5. In `handleFileUpload`: accept `filename` query param. If `gcsFileStorage` exists, upload to GCS instead of local disk. Return `filename` in response.
6. In `handleFileDownload`: if `gcsFileStorage` exists and file is in GCS, generate signed URL and return 302 redirect. Otherwise fall back to local disk serving.

```typescript
import { UPLOAD_MIME_TYPES } from '../types.js';
import type { GcsFileStorage } from './gcs-file-storage.js';

export interface FileDeps {
  fileStore?: FileStore;
  gcsFileStorage?: GcsFileStorage;
}
```

Upload: replace `IMAGE_MIME_TYPES` check with `UPLOAD_MIME_TYPES`:
```typescript
if (!UPLOAD_MIME_TYPES.includes(contentType as any)) {
  sendError(res, 400, `Unsupported content type: ${contentType}. Allowed: ${UPLOAD_MIME_TYPES.join(', ')}`);
  return;
}
```

Upload: add `filename` param, GCS path:
```typescript
const originalFilename = getQueryParam(url, 'filename') ?? `${filename}`;

if (deps?.gcsFileStorage) {
  await deps.gcsFileStorage.upload(fileId, body, contentType, originalFilename);
} else {
  // Local fallback
  const wsDir = userWorkspaceDir(agent, user);
  const filesDir = safePath(wsDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const filePath = safePath(filesDir, filename);
  writeFileSync(filePath, body);
}

deps?.fileStore?.register(fileId, agent, user, contentType, originalFilename);
const responseBody = JSON.stringify({ fileId, mimeType: contentType, filename: originalFilename, size: body.length });
```

Download: add GCS signed URL redirect:
```typescript
// After FileStore lookup, before local file serving:
if (deps?.gcsFileStorage) {
  const entry = await deps.fileStore?.lookup(fileId);
  if (entry) {
    try {
      const url = await deps.gcsFileStorage.getSignedUrl(fileId, entry.filename || fileId.split('/').pop() || 'download');
      res.writeHead(302, { Location: url });
      res.end();
      return;
    } catch (err) {
      logger.warn('gcs_signed_url_failed', { fileId, error: (err as Error).message });
      // Fall through to local serving
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/host/server-files.test.ts`
Expected: PASS

**Step 5: Run full build**

Run: `npm run build`
Expected: PASS

**Step 6: Commit**

```bash
git add src/host/server-files.ts tests/host/server-files.test.ts
git commit -m "feat: GCS upload/signed-URL-redirect for /v1/files endpoint, support all file types"
```

---

### Task 5: Wire GCS file storage into the server

**Files:**
- Modify: `src/host/server-request-handlers.ts:536-549` (pass gcsFileStorage to handleFileUpload/Download)
- Modify: the server bootstrap code that creates the file deps

**Step 1: Find where fileStore is created and passed to handlers**

Look at `src/host/server-request-handlers.ts` — `fileStore` is already passed in the deps. Add `gcsFileStorage` alongside it.

Create the `GcsFileStorage` instance during server startup if `config.workspace.bucket` is set:
- Lazy-import `@google-cloud/storage`
- Create bucket reference
- Call `createGcsFileStorage(bucket, config.workspace.prefix ?? '')`
- Pass to request handlers

**Step 2: Update server-request-handlers.ts**

In the `handleFileUpload` and `handleFileDownload` calls (lines 538, 549), pass `gcsFileStorage`:
```typescript
await handleFileUpload(req, res, { fileStore, gcsFileStorage });
// ...
await handleFileDownload(req, res, { fileStore, gcsFileStorage });
```

Add `gcsFileStorage` to the handler deps type/closure.

**Step 3: Create GcsFileStorage in server startup**

In the file where `fileStore` is created (likely the main server setup), add:
```typescript
let gcsFileStorage: GcsFileStorage | undefined;
if (config.workspace.bucket) {
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage();
  const bucket = storage.bucket(config.workspace.bucket);
  const { createGcsFileStorage } = await import('./gcs-file-storage.js');
  gcsFileStorage = createGcsFileStorage(bucket, config.workspace.prefix ?? '');
}
```

**Step 4: Run build and tests**

Run: `npm run build && npm test -- --run tests/host/server-files.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-request-handlers.ts <server-startup-file>
git commit -m "feat: wire GCS file storage into server request handlers"
```

---

### Task 6: Upload generated images/artifacts to GCS in server-completions.ts

**Files:**
- Modify: `src/host/server-completions.ts:1357-1403`

**Step 1: Update `extractImageDataBlocks` to upload to GCS**

The function at line 242 currently writes image_data blocks to local disk. When `gcsFileStorage` is available, upload to GCS instead.

Add `gcsFileStorage` as an optional parameter to `extractImageDataBlocks`:
```typescript
export function extractImageDataBlocks(
  blocks: ContentBlock[],
  wsDir: string,
  logger: Logger,
  gcsFileStorage?: GcsFileStorage,
): { blocks: ContentBlock[]; extractedFiles: ExtractedFile[] }
```

Inside the function, replace the local write with:
```typescript
if (gcsFileStorage) {
  // Upload to GCS (fire-and-forget logged errors — file is also in extractedFiles for immediate use)
  gcsFileStorage.upload(fileId, buf, block.mimeType, filename).catch(err => {
    logger.warn('gcs_image_upload_failed', { fileId, error: (err as Error).message });
  });
} else {
  writeFileSync(filePath, buf);
}
```

**Step 2: Update generated images persistence (lines 1391-1403)**

Replace local `writeFileSync` with GCS upload when available:
```typescript
if (deps.gcsFileStorage) {
  await deps.gcsFileStorage.upload(img.fileId, img.data, img.mimeType, img.fileId.split('/').pop() ?? 'image');
} else {
  const filePath = safePath(userWsPath, ...img.fileId.split('/').filter(Boolean));
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, img.data);
}
```

**Step 3: Add `gcsFileStorage` to `CompletionDeps` interface**

```typescript
export interface CompletionDeps {
  // ... existing fields ...
  gcsFileStorage?: GcsFileStorage;
}
```

**Step 4: Run build and existing tests**

Run: `npm run build && npm test`
Expected: PASS (existing tests don't provide gcsFileStorage, so fallback to local)

**Step 5: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: upload generated images/artifacts to GCS when configured"
```

---

### Task 7: Immediate GCS upload on workspace_write IPC

**Files:**
- Modify: `src/host/ipc-handlers/workspace.ts:56-83`
- Test: `tests/host/ipc-handlers/workspace.test.ts`

**Step 1: Update workspace_write handler**

Add `gcsFileStorage` and `fileStore` to the handler options:
```typescript
export interface WorkspaceHandlerOptions {
  agentName: string;
  profile: string;
  gcsFileStorage?: GcsFileStorage;
  fileStore?: FileStore;
}
```

After the existing `writeFileSync` (line 73), add GCS upload:
```typescript
// Upload to GCS for persistent access via /v1/files
if (opts.gcsFileStorage) {
  const ext = req.path.split('.').pop() ?? '';
  const fileId = `files/${randomUUID()}.${ext}`;
  const buf = Buffer.from(req.content, 'utf-8');
  const mimeType = extToMime(ext) ?? 'application/octet-stream';
  await opts.gcsFileStorage.upload(fileId, buf, mimeType, req.path.split('/').pop() ?? req.path);
  await opts.fileStore?.register(fileId, opts.agentName, ctx.userId ?? 'unknown', mimeType, req.path.split('/').pop() ?? '');
  return { written: true, tier, path: req.path, fileId };
}
```

Note: The local write still happens (needed for sandbox filesystem access). The GCS upload is additional.

**Step 2: Run existing workspace tests**

Run: `npm test -- --run tests/host/ipc-handlers/workspace.test.ts`
Expected: PASS (existing tests don't provide gcsFileStorage)

**Step 3: Add test for GCS upload on write**

Add to `tests/host/ipc-handlers/workspace.test.ts`:
```typescript
test('workspace_write uploads to GCS when configured', async () => {
  const gcsUpload = vi.fn().mockResolvedValue(undefined);
  const gcsFileStorage = { upload: gcsUpload, getSignedUrl: vi.fn(), exists: vi.fn(), download: vi.fn() };
  const fileStore = { register: vi.fn().mockResolvedValue(undefined), lookup: vi.fn(), close: vi.fn() };

  // ... create handlers with gcsFileStorage and fileStore in opts ...
  // ... call workspace_write ...

  expect(gcsUpload).toHaveBeenCalled();
  expect(result.fileId).toBeDefined();
});
```

**Step 4: Run tests**

Run: `npm test -- --run tests/host/ipc-handlers/workspace.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/ipc-handlers/workspace.ts tests/host/ipc-handlers/workspace.test.ts
git commit -m "feat: immediate GCS upload on workspace_write IPC"
```

---

### Task 8: Provision uploaded files into sandbox workspace

**Files:**
- Modify: `src/host/server-completions.ts` (in processCompletion, before agent spawn)

**Step 1: Add file provisioning logic**

In `processCompletion`, after workspace mount but before agent spawn, check for `file`/`image` content blocks in the incoming message and provision them into the sandbox:

```typescript
// Provision uploaded files into sandbox workspace so agent can access via CLI tools
if (Array.isArray(content)) {
  const fileBlocks = content.filter(b => b.type === 'file' || b.type === 'image');
  if (fileBlocks.length > 0 && userWsPath) {
    const filesDir = safePath(userWsPath, 'files');
    mkdirSync(filesDir, { recursive: true });
    for (const block of fileBlocks) {
      const fid = 'fileId' in block ? block.fileId : undefined;
      if (!fid) continue;
      try {
        let data: Buffer | undefined;
        if (deps.gcsFileStorage) {
          data = await deps.gcsFileStorage.download(fid);
        } else if (deps.fileStore) {
          const entry = await deps.fileStore.lookup(fid);
          if (entry) {
            const segments = fid.split('/').filter(Boolean);
            const filePath = safePath(userWorkspaceDir(agentName, currentUserId), ...segments);
            if (existsSync(filePath)) data = readFileSync(filePath);
          }
        }
        if (data) {
          const segments = fid.split('/').filter(Boolean);
          const destPath = safePath(userWsPath, ...segments);
          mkdirSync(dirname(destPath), { recursive: true });
          writeFileSync(destPath, data);
        }
      } catch (err) {
        reqLogger.warn('file_provision_failed', { fileId: fid, error: (err as Error).message });
      }
    }
  }
}
```

**Step 2: Run build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: provision uploaded files into sandbox workspace before agent processing"
```

---

### Task 9: Update Slack channel handler to use GCS pipeline

**Files:**
- Modify: `src/host/server-channels.ts:34-84`

**Step 1: Update `buildContentWithAttachments` to support all file types and upload to GCS**

Currently this function only handles images. Expand to:
1. Process all attachments (not just images)
2. Upload each to GCS via file upload pipeline
3. Return `file`/`image` content blocks with fileIds

Add `gcsFileStorage` and `fileStore` as optional parameters:

```typescript
export async function buildContentWithAttachments(
  textContent: string,
  attachments: Attachment[],
  logger: Logger,
  downloadFn?: (att: Attachment) => Promise<Buffer | undefined>,
  opts?: { gcsFileStorage?: GcsFileStorage; fileStore?: FileStore; agentName?: string; userId?: string },
): Promise<string | ContentBlock[]>
```

Inside the function:
- For image attachments: create `image` blocks with fileIds (upload to GCS)
- For document attachments: create `file` blocks with fileIds (upload to GCS)
- Register all files in FileStore

**Step 2: Update the call site in `registerChannelHandler`** (line 234)

Pass the GCS deps through from completionDeps:
```typescript
const messageContent = msg.attachments.length > 0
  ? await buildContentWithAttachments(msg.content, msg.attachments, logger, downloadFn, {
      gcsFileStorage: completionDeps.gcsFileStorage,
      fileStore: completionDeps.fileStore,
      agentName,
      userId: msg.sender,
    })
  : msg.content;
```

**Step 3: Run build and tests**

Run: `npm run build && npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/server-channels.ts
git commit -m "feat: Slack attachments upload to GCS and produce file content blocks"
```

---

### Task 10: Web chat UI — file attachments in composer

**Files:**
- Modify: `ui/chat/src/components/thread.tsx`
- Modify: `ui/chat/src/lib/ax-chat-transport.ts`
- Modify: `ui/chat/src/lib/useAxChatRuntime.tsx`

**Step 1: Add attachment support to the transport**

In `ax-chat-transport.ts`, update `prepareSendMessagesRequest` to include file/image content blocks from message attachments. The assistant-ui framework provides attachments on UIMessage objects — map them to content blocks:

```typescript
prepareSendMessagesRequest: async (options) => ({
  body: {
    model: opts.model ?? 'default',
    stream: true,
    user: options.id ? `${user}/${options.id}` : user,
    messages: options.messages.map((m) => {
      const parts: any[] = [];
      const text = extractText(m);
      if (text) parts.push({ type: 'text', text });
      // Include file attachments as content blocks
      if (m.experimental_attachments) {
        for (const att of m.experimental_attachments) {
          if (att.contentType?.startsWith('image/')) {
            parts.push({ type: 'image', fileId: att.url, mimeType: att.contentType });
          } else {
            parts.push({ type: 'file', fileId: att.url, mimeType: att.contentType, filename: att.name });
          }
        }
      }
      return {
        role: m.role,
        content: parts.length > 1 ? parts : text,
      };
    }),
  },
}),
```

**Step 2: Enable file attachments in the runtime**

In `useAxChatRuntime.tsx`, configure the runtime to support attachments by providing an `adapters.attachments` configuration that uploads files to `/v1/files`:

```typescript
adapters: {
  attachments: {
    accept: 'image/*,.pdf,.txt,.csv,.md,.json,.xlsx',
    async send(attachment) {
      const resp = await fetch(`/v1/files?agent=main&user=${userId}&filename=${encodeURIComponent(attachment.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': attachment.type },
        body: attachment.file,
      });
      const { fileId } = await resp.json();
      return { ...attachment, url: fileId, contentType: attachment.type };
    },
  },
},
```

**Step 3: Add attachment button to Composer**

In `thread.tsx`, add `ComposerPrimitive.AddAttachment` to the Composer component:

```tsx
<ComposerPrimitive.AddAttachment asChild>
  <button className="p-1.5 text-muted-foreground hover:text-foreground transition-colors duration-150">
    <PaperclipIcon className="size-4" />
  </button>
</ComposerPrimitive.AddAttachment>
```

Import `PaperclipIcon` from `lucide-react`.

**Step 4: Run the UI build**

Run: `cd ui/chat && npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add ui/chat/src/
git commit -m "feat: file attachment support in web chat composer with upload to /v1/files"
```

---

### Task 11: Web chat UI — render file/image artifacts in messages

**Files:**
- Modify: `ui/chat/src/components/thread.tsx`
- Modify: `ui/chat/src/lib/ax-chat-transport.ts`

**Step 1: Handle image/file blocks in the SSE stream parser**

In `ax-chat-transport.ts`, when parsing SSE deltas, detect `image`/`file` content blocks in the response and emit appropriate UIMessageChunk events. The OpenAI-compatible SSE format may include these as custom content parts.

**Step 2: Render image blocks**

In `thread.tsx`, add an Image component to `MessagePrimitive.Parts`:

```tsx
const ImageBlock: FC<{ fileId: string }> = ({ fileId }) => (
  <img
    src={`/v1/files/${fileId}`}
    alt="Generated image"
    className="my-2 max-w-md rounded-lg border border-border/40"
    loading="lazy"
  />
);
```

**Step 3: Render file blocks**

Add a FileChip component:
```tsx
const FileChip: FC<{ fileId: string; filename: string; mimeType: string }> = ({ fileId, filename }) => (
  <a
    href={`/v1/files/${fileId}`}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-2 rounded-lg border border-border/40 bg-card/60 px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors my-1"
  >
    <FileIcon className="size-4" />
    <span>{filename}</span>
    <DownloadIcon className="size-3.5 text-muted-foreground" />
  </a>
);
```

**Step 4: Build UI**

Run: `cd ui/chat && npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add ui/chat/src/
git commit -m "feat: render image artifacts and file download chips in chat messages"
```

---

### Task 12: Handle file_data stripping in content serialization

**Files:**
- Modify: `src/utils/content-serialization.ts` (if it exists — ensure `file_data` blocks are stripped before persistence, same as `image_data`)
- Modify: `src/host/server-completions.ts` (add `file_data` extraction similar to `extractImageDataBlocks`)

**Step 1: Extend `extractImageDataBlocks` to also handle `file_data`**

Rename to `extractTransientDataBlocks` or keep the name and add `file_data` handling:

```typescript
if (block.type === 'file_data') {
  try {
    const buf = Buffer.from(block.data, 'base64');
    const ext = mimeToExt(block.mimeType) ?? '.bin';
    const filename = `${randomUUID()}${ext}`;
    const fileId = `files/${filename}`;
    // ... same upload/write pattern as image_data ...
    converted.push({ type: 'file', fileId, mimeType: block.mimeType, filename: block.filename });
    extractedFiles.push({ fileId, mimeType: block.mimeType, data: buf });
  } catch (err) { ... }
}
```

**Step 2: Run build and tests**

Run: `npm run build && npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-completions.ts src/utils/content-serialization.ts
git commit -m "feat: strip file_data blocks before persistence, same as image_data"
```

---

### Task 13: End-to-end integration test

**Files:**
- Create: `tests/host/file-attachments-e2e.test.ts`

**Step 1: Write integration test**

Test the full flow: upload → completion with file block → download with signed URL redirect (mocked GCS).

```typescript
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFileUpload, handleFileDownload } from '../../src/host/server-files.js';
// ... setup with mock GCS, FileStore, etc. ...

describe('File attachments E2E', () => {
  test('upload PDF → download returns 302 to signed URL', async () => {
    // Upload a PDF
    // Verify GCS.upload was called
    // Download by fileId
    // Verify 302 redirect with signed URL
  });

  test('upload image → content block in completion → download works', async () => {
    // Upload an image
    // Verify fileId returned
    // Download by fileId
    // Verify image data matches
  });

  test('local fallback when no GCS', async () => {
    // Upload without GCS
    // Download serves from local disk
    // Verify 200 with file content
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run tests/host/file-attachments-e2e.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add tests/host/file-attachments-e2e.test.ts
git commit -m "test: add file attachments E2E integration tests"
```

---

### Task 14: Final build verification and cleanup

**Step 1: Run full build**

Run: `npm run build`
Expected: PASS

**Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 3: Verify no stale imports or unused code**

Check that all new imports are used and no dead code was left behind.

**Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: cleanup file attachments implementation"
```
