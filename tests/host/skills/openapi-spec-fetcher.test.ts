/**
 * Unit tests for the default `fetchOpenApiSpec` closure that
 * `makeDefaultFetchOpenApiSpec` produces — the concrete I/O layer that
 * `populateCatalogFromSkills` gets wired with in production. The orchestrator
 * itself is tested separately (`catalog-population.test.ts`) with a vi.fn()
 * mock; these tests cover the path/URL resolution + git-repo file reading
 * + SwaggerParser.dereference call.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeDefaultFetchOpenApiSpec } from '../../../src/host/skills/openapi-spec-fetcher.js';

const execFileAsync = promisify(execFile);

/** Build a bare git repo populated with a .ax/skills/<skillName>/ directory
 *  containing the provided files. Returns the bare-repo path the production
 *  `getBareRepoPath` would hand back. */
async function makeBareRepo(
  skillName: string,
  files: Record<string, string>,
): Promise<{ bareRepoPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'ax-openapi-fetcher-'));
  const workTree = join(root, 'work');
  const bare = join(root, 'bare.git');

  await mkdir(workTree, { recursive: true });
  const skillDir = join(workTree, '.ax', 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(skillDir, relPath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  await execFileAsync('git', ['init', '-b', 'main', workTree]);
  await execFileAsync('git', ['-C', workTree, 'config', 'user.email', 't@test']);
  await execFileAsync('git', ['-C', workTree, 'config', 'user.name', 'test']);
  await execFileAsync('git', ['-C', workTree, 'add', '-A']);
  await execFileAsync('git', ['-C', workTree, 'commit', '-m', 'init']);
  await execFileAsync('git', ['clone', '--bare', workTree, bare]);
  return {
    bareRepoPath: bare,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe('makeDefaultFetchOpenApiSpec', () => {
  const petstoreV3 = {
    openapi: '3.0.3',
    info: { title: 'tiny', version: '1' },
    paths: {
      '/ping': {
        get: { operationId: 'ping', responses: { '200': { description: 'ok' } } },
      },
    },
  };

  const cleanups: Array<() => Promise<void>> = [];
  beforeEach(() => { cleanups.length = 0; });
  afterEach(async () => {
    for (const c of cleanups) await c().catch(() => undefined);
  });

  test('reads a workspace-relative spec from the skill\'s directory in the bare repo', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.json': JSON.stringify(petstoreV3),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    const doc = await fetch('petstore', {
      spec: './openapi.json',
      baseUrl: 'https://petstore.test',
    });
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths?.['/ping']).toBeDefined();
  });

  test('accepts a spec path without leading ./', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'specs/api.json': JSON.stringify(petstoreV3),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    const doc = await fetch('petstore', {
      spec: 'specs/api.json',
      baseUrl: 'https://petstore.test',
    });
    expect(doc.openapi).toBe('3.0.3');
  });

  test('rejects traversal attempts (../) on workspace-relative specs', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.json': JSON.stringify(petstoreV3),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    await expect(
      fetch('petstore', { spec: '../../etc/passwd', baseUrl: 'https://petstore.test' }),
    ).rejects.toThrow(/traversal|invalid/i);
  });

  test('rejects nested traversal attempts (specs/../../etc/passwd)', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.json': JSON.stringify(petstoreV3),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    await expect(
      fetch('petstore', { spec: 'specs/../../../etc/passwd', baseUrl: 'https://test' }),
    ).rejects.toThrow(/traversal|invalid/i);
  });

  test('rejects absolute paths on workspace-relative specs', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.json': JSON.stringify(petstoreV3),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    await expect(
      fetch('petstore', { spec: '/etc/passwd', baseUrl: 'https://petstore.test' }),
    ).rejects.toThrow(/absolute|invalid/i);
  });

  test('rejects v2 (Swagger) specs with a descriptive error', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('swagger', {
      'openapi.json': JSON.stringify({
        swagger: '2.0',
        info: { title: 't', version: '1' },
        paths: {},
      }),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    await expect(
      fetch('swagger', { spec: './openapi.json', baseUrl: 'https://test' }),
    ).rejects.toThrow(/v2|Swagger|3\./);
  });

  test('parses YAML flow syntax that starts with { (falls back from JSON)', async () => {
    // YAML's flow syntax lets a doc start with `{` — valid YAML, invalid JSON
    // (unquoted keys, `/ping` as a bare key). Previous implementation
    // branched on first char and threw "Failed to parse JSON spec" instead
    // of falling back to YAML.
    const yamlFlow = '{openapi: "3.0.3", info: {title: tiny, version: "1"}, paths: {/ping: {get: {operationId: ping, responses: {"200": {description: ok}}}}}}\n';
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.yaml': yamlFlow,
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    const doc = await fetch('petstore', {
      spec: './openapi.yaml',
      baseUrl: 'https://petstore.test',
    });
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths?.['/ping']).toBeDefined();
  });

  test('parses YAML workspace specs', async () => {
    const yaml = [
      'openapi: 3.0.3',
      'info:',
      '  title: tiny',
      '  version: "1"',
      'paths:',
      '  /ping:',
      '    get:',
      '      operationId: ping',
      '      responses:',
      '        "200":',
      '          description: ok',
      '',
    ].join('\n');
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.yaml': yaml,
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    const doc = await fetch('petstore', {
      spec: './openapi.yaml',
      baseUrl: 'https://petstore.test',
    });
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths?.['/ping']).toBeDefined();
  });

  test('throws when the workspace spec file is missing from the skill directory', async () => {
    const { bareRepoPath, cleanup } = await makeBareRepo('petstore', {
      'openapi.json': JSON.stringify(petstoreV3),
    });
    cleanups.push(cleanup);

    const fetch = makeDefaultFetchOpenApiSpec({
      getBareRepoPath: vi.fn().mockResolvedValue(bareRepoPath),
    });
    await expect(
      fetch('petstore', { spec: './missing.json', baseUrl: 'https://petstore.test' }),
    ).rejects.toThrow();
  });
});
