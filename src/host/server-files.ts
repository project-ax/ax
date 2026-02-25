/**
 * File upload/download API for the web UI.
 *
 * Stores files in the session workspace under a `files/` subdirectory.
 * Images referenced in chat messages use fileId values relative to the
 * workspace root (e.g. "files/abc123.png").
 *
 * Endpoints:
 *   POST /v1/files?session_id=<id>   — upload a file (raw binary body)
 *   GET  /v1/files/<fileId>?session_id=<id> — download a file
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidSessionId, workspaceDir } from '../paths.js';
import { safePath } from '../utils/safe-path.js';
import { sendError } from './server-http.js';
import type { ImageMimeType } from '../types.js';
import { IMAGE_MIME_TYPES } from '../types.js';

/** Max upload size: 10 MB. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Map MIME types to file extensions. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Map extensions back to MIME types for download. */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Read raw binary body from a request, with a size limit. */
async function readBinaryBody(req: IncomingMessage, maxSize: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxSize) throw new Error('File too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Extract a query parameter from a URL string. */
function getQueryParam(url: string, name: string): string | undefined {
  const idx = url.indexOf('?');
  if (idx < 0) return undefined;
  const params = new URLSearchParams(url.slice(idx));
  return params.get(name) ?? undefined;
}

/**
 * Handle POST /v1/files — upload a file to the session workspace.
 *
 * Expects raw binary body with Content-Type header indicating MIME type.
 * Returns JSON: { fileId, mimeType, size }
 */
export async function handleFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? '';
  const sessionId = getQueryParam(url, 'session_id');

  if (!sessionId || !isValidSessionId(sessionId)) {
    sendError(res, 400, 'Missing or invalid session_id query parameter');
    return;
  }

  // Validate MIME type
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.includes(contentType as ImageMimeType)) {
    sendError(res, 400, `Unsupported content type: ${contentType}. Allowed: ${IMAGE_MIME_TYPES.join(', ')}`);
    return;
  }

  // Read binary body
  let body: Buffer;
  try {
    body = await readBinaryBody(req, MAX_FILE_SIZE);
  } catch {
    sendError(res, 413, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    return;
  }

  if (body.length === 0) {
    sendError(res, 400, 'Empty file body');
    return;
  }

  // Generate unique filename and store
  const ext = MIME_TO_EXT[contentType] ?? '.bin';
  const filename = `${randomUUID()}${ext}`;
  const wsDir = workspaceDir(sessionId);
  const filesDir = safePath(wsDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const filePath = safePath(filesDir, filename);
  writeFileSync(filePath, body);

  const fileId = `files/${filename}`;
  const responseBody = JSON.stringify({ fileId, mimeType: contentType, size: body.length });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(responseBody),
  });
  res.end(responseBody);
}

/**
 * Handle GET /v1/files/<fileId> — download a file from the session workspace.
 *
 * Requires session_id query parameter. Serves the file with correct Content-Type.
 */
export async function handleFileDownload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? '';
  const sessionId = getQueryParam(url, 'session_id');

  if (!sessionId || !isValidSessionId(sessionId)) {
    sendError(res, 400, 'Missing or invalid session_id query parameter');
    return;
  }

  // Extract fileId from URL path: /v1/files/<fileId>
  const pathPart = url.split('?')[0];
  const prefix = '/v1/files/';
  if (!pathPart.startsWith(prefix)) {
    sendError(res, 400, 'Invalid file path');
    return;
  }
  const fileId = decodeURIComponent(pathPart.slice(prefix.length));
  if (!fileId) {
    sendError(res, 400, 'Missing file ID');
    return;
  }

  // Resolve file path safely
  const wsDir = workspaceDir(sessionId);
  const segments = fileId.split('/').filter(Boolean);
  const filePath = safePath(wsDir, ...segments);

  if (!existsSync(filePath)) {
    sendError(res, 404, 'File not found');
    return;
  }

  // Determine MIME type from extension
  const ext = extname(basename(filePath)).toLowerCase();
  const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';

  const data = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(data);
}
