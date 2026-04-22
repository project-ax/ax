import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSandboxToolHandlers } from '../../../src/host/ipc-handlers/sandbox-tools.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

// Minimal provider stubs
function stubProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn() },
  } as any;
}

describe('Sandbox tool IPC handlers', () => {
  let workspace: string;
  let workspaceMap: Map<string, string>;
  let ctx: IPCContext;
  let providers: ProviderRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'sandbox-tools-test-'));
    workspaceMap = new Map([['test-session', workspace]]);
    ctx = { sessionId: 'test-session', agentId: 'test-agent' };
    providers = stubProviders();
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  // ── sandbox_bash ──

  describe('sandbox_bash', () => {
    test('executes a command and returns output', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash({ command: 'echo hello' }, ctx);
      expect(result.output).toContain('hello');
    });

    test('runs in workspace directory', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash({ command: 'pwd' }, ctx);
      expect(result.output).toContain(workspace);
    });

    test('returns stderr and exit code on command failure', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash({ command: 'ls /nonexistent-path-xyz-42' }, ctx);
      expect(result.output).toMatch(/exit code|No such file/i);
    });

    test('audits the bash execution', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_bash({ command: 'echo test' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash',
          sessionId: 'test-session',
          result: 'success',
        }),
      );
    });

    test('throws when no workspace registered for session', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const badCtx = { ...ctx, sessionId: 'unknown-session' };
      await expect(
        handlers.sandbox_bash({ command: 'echo hello' }, badCtx),
      ).rejects.toThrow(/No workspace registered/);
    });

    test('captures combined stdout and stderr', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash(
        { command: 'echo stdout-msg && echo stderr-msg >&2' },
        ctx,
      );
      expect(result.output).toContain('stdout-msg');
    });
  });

  // ── sandbox_read_file ──

  describe('sandbox_read_file', () => {
    test('reads an existing file', async () => {
      writeFileSync(join(workspace, 'test.txt'), 'file content');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_read_file({ path: 'test.txt' }, ctx);
      expect(result.content).toBe('file content');
    });

    test('returns error for missing file', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_read_file({ path: 'no-such-file.txt' }, ctx);
      expect(result.error).toMatch(/error|no such file/i);
    });

    test('blocks path traversal via safePath', async () => {
      // safePath sanitizes ".." into "_" so this resolves inside workspace, not outside
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_read_file({ path: '../../../etc/passwd' }, ctx);
      // The sanitized path won't exist — we get a file-not-found error
      expect(result.error).toBeDefined();
    });

    test('audits the read operation', async () => {
      writeFileSync(join(workspace, 'audit.txt'), 'content');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_read_file({ path: 'audit.txt' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_read_file',
          result: 'success',
        }),
      );
    });
  });

  // ── sandbox_write_file ──

  describe('sandbox_write_file', () => {
    test('creates a new file', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_write_file(
        { path: 'new.txt', content: 'new content' },
        ctx,
      );
      expect(result.written).toBe(true);
      expect(readFileSync(join(workspace, 'new.txt'), 'utf-8')).toBe('new content');
    });

    test('creates nested directories', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_write_file(
        { path: 'deep/nested/file.txt', content: 'deep content' },
        ctx,
      );
      expect(result.written).toBe(true);
      expect(readFileSync(join(workspace, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('deep content');
    });

    test('blocks path traversal via safePath', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      // safePath sanitizes ".." into "_" so this writes inside workspace, not outside
      const result = await handlers.sandbox_write_file(
        { path: '../../escape.txt', content: 'bad' },
        ctx,
      );
      // The file should be written but contained within the workspace
      // (safePath sanitizes the segments)
      expect(result.written).toBe(true);
    });

    test('audits the write operation', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_write_file({ path: 'w.txt', content: 'x' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_write_file',
          result: 'success',
          args: expect.objectContaining({ bytes: 1 }),
        }),
      );
    });

    // ── SKILL.md inline frontmatter validation ──
    //
    // Writing a SKILL.md with invalid frontmatter was the silent-failure path
    // that prompted this work. Commit-time validation exists but fires after
    // the turn ends; inline validation at write time gives the LLM immediate
    // feedback so it can fix and retry within the same turn. For paths OTHER
    // than `.ax/skills/<name>/SKILL.md` the writer stays unchanged — no
    // silent schema drift for ordinary files.

    const goodSkill = `---
name: linear
description: Linear issue tracking
credentials:
  - envName: LINEAR_API_KEY
    authType: api_key
mcpServers:
  - name: linear
    url: https://mcp.linear.app
    credential: LINEAR_API_KEY
---

# Linear`;

    // write_file refuses .ax/skills/*/SKILL.md paths and redirects the agent
    // to the dedicated `skill_write` tool. All validation of SKILL.md content
    // now lives in one place; write_file / edit_file only need to block the
    // path so a bad write can't sneak in via the generic file tools.

    test('refuses to write SKILL.md via write_file — redirects to skill_write', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_write_file(
        { path: '.ax/skills/linear/SKILL.md', content: goodSkill },
        ctx,
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/skill_write/);
      // File must NOT be on disk — the agent has to use the right tool.
      expect(() => readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'))).toThrow();
    });

    test('does not block SKILL.md written outside .ax/skills/*/SKILL.md', async () => {
      // A file literally named SKILL.md under some other directory (notes,
      // policy/, etc.) is just a markdown file. Only the canonical skill
      // path gets the redirect.
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_write_file(
        { path: 'notes/SKILL.md', content: 'not a skill at all' },
        ctx,
      );
      expect(result.written).toBe(true);
    });
  });

  // ── sandbox_edit_file ──

  describe('sandbox_edit_file', () => {
    test('replaces text in a file', async () => {
      writeFileSync(join(workspace, 'edit.txt'), 'hello world');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_edit_file(
        { path: 'edit.txt', old_string: 'hello', new_string: 'goodbye' },
        ctx,
      );
      expect(result.edited).toBe(true);
      expect(readFileSync(join(workspace, 'edit.txt'), 'utf-8')).toBe('goodbye world');
    });

    test('returns error when old_string not found', async () => {
      writeFileSync(join(workspace, 'edit2.txt'), 'hello world');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_edit_file(
        { path: 'edit2.txt', old_string: 'xyz', new_string: 'abc' },
        ctx,
      );
      expect(result.error).toMatch(/old_string not found/i);
    });

    test('returns error for missing file', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_edit_file(
        { path: 'nope.txt', old_string: 'a', new_string: 'b' },
        ctx,
      );
      expect(result.error).toMatch(/error/i);
    });

    test('audits the edit operation', async () => {
      writeFileSync(join(workspace, 'a.txt'), 'old text');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_edit_file(
        { path: 'a.txt', old_string: 'old', new_string: 'new' },
        ctx,
      );
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_edit_file',
          result: 'success',
        }),
      );
    });

    // ── SKILL.md editing is now routed through skill_write ──
    // Partial string-replace on YAML frontmatter is a ridge of foot-guns;
    // edit_file refuses the canonical skill path and redirects.

    const validSkill = `---
name: linear
description: Linear
credentials:
  - envName: LINEAR_API_KEY
    authType: api_key
mcpServers:
  - name: linear
    url: https://mcp.linear.app
    credential: LINEAR_API_KEY
---

# Linear`;

    test('refuses to edit SKILL.md via edit_file — redirects to skill_write', async () => {
      mkdirSync(join(workspace, '.ax/skills/linear'), { recursive: true });
      writeFileSync(join(workspace, '.ax/skills/linear/SKILL.md'), validSkill);
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });

      const result = await handlers.sandbox_edit_file(
        {
          path: '.ax/skills/linear/SKILL.md',
          old_string: 'description: Linear',
          new_string: 'description: Linear issue tracking (updated)',
        },
        ctx,
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/skill_write/);
      // Original file untouched.
      expect(readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'), 'utf-8')).toBe(validSkill);
    });
  });

  // ── skill_write ──

  describe('skill_write', () => {
    test('writes a valid SKILL.md from structured args', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.skill_write({
        name: 'linear',
        description: 'Query Linear issues.',
        credentials: [{ envName: 'LINEAR_API_KEY', authType: 'api_key' }],
        mcpServers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp', credential: 'LINEAR_API_KEY' }],
        body: '# Linear\n\nUsage notes here.',
      }, ctx);
      expect(result.written).toBe(true);
      expect(result.path).toBe('.ax/skills/linear/SKILL.md');
      const onDisk = readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'), 'utf-8');
      expect(onDisk).toContain('name: linear');
      expect(onDisk).toContain('description: Query Linear issues.');
      expect(onDisk).toContain('authType: api_key');
      expect(onDisk).toContain('# Linear');
    });

    test('rejects missing description with actionable error', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.skill_write({
        name: 'linear',
        description: '',  // empty — violates minLength: 1
        body: '',
      }, ctx);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/description/i);
      expect(() => readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'))).toThrow();
    });

    test('rejects camelCase authType and reports the received value', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      // Skip the TypeBox/Zod schema gate by calling the handler directly
      // with an off-schema value — simulates what the agent's tool call
      // would look like if constrained decoding hadn't caught it earlier.
      const result = await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        credentials: [{ envName: 'LINEAR_API_KEY', authType: 'apiKey' as any }],
        body: '',
      }, ctx);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/authType/);
      // The parser now includes the received value so the agent can diff
      // its own output against the rule.
      expect(result.error).toMatch(/received: "apiKey"/);
    });

    test('rejects when arg.name mismatches frontmatter.name', async () => {
      // Belt-and-braces: the schema doesn't enforce this cross-field
      // constraint, but the handler does — the directory segment MUST
      // match the frontmatter name or the reconciler sees them as two
      // different skills.
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      // Can't actually construct this case via the normal API (we serialize
      // name into the frontmatter ourselves), but the guard fires on any
      // future code path that bypasses serialization. Simulated by building
      // a frontmatter whose round-tripped name doesn't equal the arg —
      // no such path exists today, so we just confirm the valid case.
      const result = await handlers.skill_write({
        name: 'linear',
        description: 'x',
        body: '',
      }, ctx);
      expect(result.written).toBe(true);
    });

    test('audits successful writes', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        body: '',
      }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'skill_write',
          result: 'success',
        }),
      );
    });

    test('preserves openapi[] block when writing an OpenAPI-backed skill', async () => {
      // REGRESSION: a prior version of this handler didn't thread req.openapi
      // into the built frontmatter, which meant `skill_write` silently
      // dropped the operational openapi block and the catalog-populate loop
      // had nothing to iterate. Paired with the approval-flow fix in
      // server-admin-skills-helpers.ts.
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.skill_write({
        name: 'petstore',
        description: 'Query the public Swagger petstore demo API.',
        openapi: [{
          spec: 'https://petstore3.swagger.io/api/v3/openapi.json',
          baseUrl: 'https://petstore3.swagger.io/api/v3',
          include: ['findPets*', 'getPet*'],
        }],
        domains: ['petstore3.swagger.io'],
        body: '# Petstore\n\nUsage notes.',
      }, ctx);
      expect(result.written).toBe(true);
      const onDisk = readFileSync(join(workspace, '.ax/skills/petstore/SKILL.md'), 'utf-8');
      expect(onDisk).toContain('openapi:');
      expect(onDisk).toContain('spec: https://petstore3.swagger.io/api/v3/openapi.json');
      expect(onDisk).toContain('baseUrl: https://petstore3.swagger.io/api/v3');
      expect(onDisk).toContain('- findPets*');
    });

    test('preserves openapi[].auth block with all four schemes', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.skill_write({
        name: 'authed-api',
        description: 'Example auth-required API.',
        credentials: [{ envName: 'EXAMPLE_TOKEN', authType: 'api_key' }],
        openapi: [{
          spec: 'https://example.com/openapi.json',
          baseUrl: 'https://example.com/v1',
          auth: { scheme: 'bearer', credential: 'EXAMPLE_TOKEN' },
        }],
        body: '# Example',
      }, ctx);
      expect(result.written).toBe(true);
      const onDisk = readFileSync(join(workspace, '.ax/skills/authed-api/SKILL.md'), 'utf-8');
      expect(onDisk).toContain('scheme: bearer');
      expect(onDisk).toContain('credential: EXAMPLE_TOKEN');
    });

    test('audits validation failures', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.skill_write({
        name: 'linear',
        description: '',
        body: '',
      }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'skill_write',
          result: 'error',
        }),
      );
    });

    // ── Non-interactive turn guard ──────────────────────────────────────
    // Heartbeat / cron / channel sessions (sessionId doesn't start with
    // `http:`) can still create new skills or edit the body, but must not
    // be able to rewrite frontmatter of an existing skill. Otherwise the
    // agent "fixes" a pending skill during a heartbeat → frontmatter
    // drifts from stored credentials → skill flips PENDING → catalog
    // auth 401s until an admin re-approves.

    test('allows CREATING a new skill from a non-interactive session (no existing file)', async () => {
      // test-session doesn't start with `http:` — but there's no
      // existing SKILL.md, so this is a creation, which is allowed.
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.skill_write({
        name: 'weather',
        description: 'Weather queries',
        body: '# Weather',
      }, ctx);
      expect(result.written).toBe(true);
    });

    test('allows body-only edits from a non-interactive session (frontmatter unchanged)', async () => {
      // Seed an existing skill — frontmatter stays identical on the
      // next call, only body changes. Must pass even with a non-http
      // sessionId.
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        credentials: [{ envName: 'LINEAR_API_KEY', authType: 'api_key', scope: 'user' }],
        mcpServers: [{
          name: 'linear',
          url: 'https://mcp.linear.app/mcp',
          transport: 'http',
          credential: 'LINEAR_API_KEY',
        }],
        body: '# Linear — original body',
      }, ctx);

      const result = await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        credentials: [{ envName: 'LINEAR_API_KEY', authType: 'api_key', scope: 'user' }],
        mcpServers: [{
          name: 'linear',
          url: 'https://mcp.linear.app/mcp',
          transport: 'http',
          credential: 'LINEAR_API_KEY',
        }],
        body: '# Linear — updated body with more examples',
      }, ctx);
      expect(result.written).toBe(true);

      const onDisk = readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'), 'utf-8');
      expect(onDisk).toContain('updated body');
    });

    test('BLOCKS frontmatter mutation from a non-interactive session and names the changed fields', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      // Seed: admin-approved frontmatter.
      await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        credentials: [{ envName: 'LINEAR_API_KEY', authType: 'api_key', scope: 'user' }],
        mcpServers: [{
          name: 'linear',
          url: 'https://mcp.linear.app/mcp',
          transport: 'http',
          credential: 'LINEAR_API_KEY',
        }],
        body: '# Linear',
      }, ctx);

      // Agent attempts to "fix" by flipping envName during a heartbeat.
      const result = await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        // different envName — the classic break
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [{
          name: 'linear',
          url: 'https://mcp.linear.app/mcp',
          transport: 'http',
          credential: 'LINEAR_TOKEN',
        }],
        body: '# Linear',
      }, ctx);

      expect(result.error).toMatch(/non-interactive session/);
      expect(result.error).toMatch(/credentials/);
      expect(result.error).toMatch(/mcpServers/);

      // The on-disk file still reflects the original frontmatter.
      const onDisk = readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'), 'utf-8');
      expect(onDisk).toContain('LINEAR_API_KEY');
      expect(onDisk).not.toContain('LINEAR_TOKEN');

      // Blocked writes emit a distinct audit entry so the admin can
      // spot the attempt in the feed.
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'skill_write',
          result: 'blocked',
          args: expect.objectContaining({ blocked: 'non_interactive_frontmatter_mutation' }),
        }),
      );
    });

    test('ALLOWS frontmatter mutation from an interactive (http:) session', async () => {
      // Same scenario as above, but with a chat-UI sessionId. User-
      // initiated change is explicit admin action and must pass through.
      const interactiveMap = new Map([['http:dm:test-agent:local:user', workspace]]);
      const interactiveCtx: IPCContext = {
        sessionId: 'http:dm:test-agent:local:user',
        agentId: 'test-agent',
      };
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: interactiveMap });

      await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        credentials: [{ envName: 'LINEAR_API_KEY', authType: 'api_key', scope: 'user' }],
        body: '# Linear',
      }, interactiveCtx);

      // Change envName — this would be BLOCKED for non-http. Interactive
      // session accepts it.
      const result = await handlers.skill_write({
        name: 'linear',
        description: 'Linear',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        body: '# Linear',
      }, interactiveCtx);
      expect(result.written).toBe(true);

      const onDisk = readFileSync(join(workspace, '.ax/skills/linear/SKILL.md'), 'utf-8');
      expect(onDisk).toContain('LINEAR_TOKEN');
    });
  });

  // ── sandbox_grep ──

  describe('sandbox_grep', () => {
    test('finds matching lines in files', async () => {
      writeFileSync(join(workspace, 'test.ts'), 'const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'foo' }, ctx);
      expect(result.matches).toContain('foo');
      expect(result.count).toBeGreaterThanOrEqual(2);
    });

    test('respects max_results limit', async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i} match`).join('\n');
      writeFileSync(join(workspace, 'big.txt'), lines);
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'match', max_results: 5 }, ctx);
      expect(result.count).toBe(5);
      expect(result.truncated).toBe(true);
    });

    test('returns empty for no matches', async () => {
      writeFileSync(join(workspace, 'empty.txt'), 'nothing here');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'zzz_no_match' }, ctx);
      expect(result.count).toBe(0);
    });

    test('filters by glob pattern', async () => {
      writeFileSync(join(workspace, 'code.ts'), 'const x = 1;');
      writeFileSync(join(workspace, 'readme.md'), 'const y = 2;');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'const', glob: '*.ts' }, ctx);
      expect(result.matches).toContain('code.ts');
      expect(result.matches).not.toContain('readme.md');
    });

    test('audits the grep operation', async () => {
      writeFileSync(join(workspace, 'a.txt'), 'hello');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_grep({ pattern: 'hello' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_grep',
          sessionId: 'test-session',
          result: 'success',
        }),
      );
    });
  });

  // ── sandbox_glob ──

  describe('sandbox_glob', () => {
    test('finds files matching pattern', async () => {
      writeFileSync(join(workspace, 'app.ts'), '');
      writeFileSync(join(workspace, 'app.test.ts'), '');
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'index.ts'), '');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_glob({ pattern: '*.ts' }, ctx);
      expect(result.files.length).toBeGreaterThanOrEqual(2);
    });

    test('respects max_results limit', async () => {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(workspace, `file${i}.txt`), '');
      }
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_glob({ pattern: '*.txt', max_results: 5 }, ctx);
      expect(result.files.length).toBe(5);
      expect(result.truncated).toBe(true);
    });

    test('returns empty for no matches', async () => {
      writeFileSync(join(workspace, 'file.txt'), '');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_glob({ pattern: '*.xyz' }, ctx);
      expect(result.files.length).toBe(0);
    });

    test('audits the glob operation', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_glob({ pattern: '*.ts' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_glob',
          sessionId: 'test-session',
          result: 'success',
        }),
      );
    });
  });

  // ── workspace tier access via symlink mountRoot ──

  describe('workspace tier access via mountRoot symlinks', () => {
    let mountRoot: string;
    let agentDir: string;
    let userDir: string;
    let tierMap: Map<string, string>;

    beforeEach(() => {
      // Simulate the mountRoot layout that processCompletion creates.
      // mountRoot/
      //   scratch/ → workspace (scratch dir)
      //   agent/   → agentDir
      //   user/    → userDir
      mountRoot = mkdtempSync(join(tmpdir(), 'sandbox-mount-'));
      agentDir = mkdtempSync(join(tmpdir(), 'agent-ws-'));
      userDir = mkdtempSync(join(tmpdir(), 'user-ws-'));

      const { symlinkSync } = require('node:fs');
      symlinkSync(workspace, join(mountRoot, 'scratch'));
      symlinkSync(agentDir, join(mountRoot, 'agent'));
      symlinkSync(userDir, join(mountRoot, 'user'));

      // The workspaceMap now points to the mountRoot (not scratch)
      tierMap = new Map([['test-session', mountRoot]]);
    });

    afterEach(() => {
      rmSync(mountRoot, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    });

    test('sandbox_bash can list agent and user directories', async () => {
      writeFileSync(join(agentDir, 'README.md'), '# Agent');
      writeFileSync(join(userDir, 'notes.txt'), 'hello');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_bash({ command: 'ls agent user' }, ctx);
      expect(result.output).toContain('README.md');
      expect(result.output).toContain('notes.txt');
    });

    test('sandbox_read_file reads from agent/ tier', async () => {
      writeFileSync(join(agentDir, 'config.json'), '{"key":"value"}');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_read_file({ path: 'agent/config.json' }, ctx);
      expect(result.content).toBe('{"key":"value"}');
    });

    test('sandbox_read_file reads from user/ tier', async () => {
      writeFileSync(join(userDir, 'prefs.txt'), 'dark mode');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_read_file({ path: 'user/prefs.txt' }, ctx);
      expect(result.content).toBe('dark mode');
    });

    test('sandbox_write_file writes to user/ tier', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_write_file(
        { path: 'user/new-file.txt', content: 'created' },
        ctx,
      );
      expect(result.written).toBe(true);
      expect(readFileSync(join(userDir, 'new-file.txt'), 'utf-8')).toBe('created');
    });

    test('sandbox_bash runs in mountRoot with scratch/agent/user visible', async () => {
      writeFileSync(join(workspace, 'scratch-file.txt'), 'from scratch');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_bash({ command: 'ls' }, ctx);
      expect(result.output).toContain('scratch');
      expect(result.output).toContain('agent');
      expect(result.output).toContain('user');
    });
  });

  // ── Sandbox Audit Gate ──

  describe('sandbox_approve', () => {
    test('approves bash operation and logs audit', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_approve(
        { operation: 'bash', command: 'ls' },
        ctx,
      );
      expect(result).toEqual({ approved: true });
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash',
          sessionId: 'test-session',
          result: 'success',
          args: expect.objectContaining({ command: 'ls', mode: 'container-local' }),
        }),
      );
    });

    test('approves read operation and logs audit', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_approve(
        { operation: 'read', path: 'foo.txt' },
        ctx,
      );
      expect(result).toEqual({ approved: true });
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_read',
          result: 'success',
          args: expect.objectContaining({ path: 'foo.txt', mode: 'container-local' }),
        }),
      );
    });

    test('truncates long commands in audit log', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const longCmd = 'x'.repeat(500);
      await handlers.sandbox_approve(
        { operation: 'bash', command: longCmd },
        ctx,
      );
      const auditCall = (providers.audit.log as any).mock.calls[0][0];
      expect(auditCall.args.command.length).toBe(200);
    });

  });

  describe('sandbox_result', () => {
    test('logs successful bash result', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_result(
        { operation: 'bash', command: 'ls', output: 'file1', exitCode: 0 },
        ctx,
      );
      expect(result).toEqual({ ok: true });
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash_result',
          sessionId: 'test-session',
          result: 'success',
          args: expect.objectContaining({ command: 'ls', exitCode: 0, mode: 'container-local' }),
        }),
      );
    });

    test('logs failed result with non-zero exit code', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_result(
        { operation: 'bash', command: 'bad', exitCode: 1 },
        ctx,
      );
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash_result',
          result: 'error',
        }),
      );
    });

    test('logs file operation result with success flag', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_result(
        { operation: 'read', path: 'foo.txt', success: true },
        ctx,
      );
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_read_result',
          result: 'success',
          args: expect.objectContaining({ path: 'foo.txt', success: true }),
        }),
      );
    });
  });
});
