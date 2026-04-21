/**
 * Unified tool dispatch bottleneck for all external tools (MCP + OpenAPI).
 *
 * `tool-router.ts` (from pi-agent tool_use) calls into this single dispatcher.
 * Handles server resolution, header injection, size limits, taint tagging,
 * and errors.
 */

import type { TaintTag } from '../types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'tool-dispatcher' });

export const DISPATCH_LIMITS = {
  maxResultSizeBytes: 1_048_576,   // 1 MB per result
} as const;

export interface DispatchCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface DispatchContext {
  agentId: string;
  sessionId: string;
  userId: string;
}

export interface DispatchResult {
  content: string;
  isError?: boolean;
  taint?: TaintTag;
}

export interface ToolDispatcherOptions {
  /** Resolve tool name → MCP/API server URL. */
  resolveServer: (agentId: string, toolName: string) => string | undefined;
  /** Execute tool on resolved server. */
  callTool: (
    serverUrl: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: { headers?: Record<string, string> },
  ) => Promise<{ content: string | Record<string, unknown>; isError?: boolean }>;
  /** Get server metadata for credential resolution. */
  getServerMeta?: (agentId: string, serverUrl: string) =>
    { name?: string; headers?: Record<string, string> } | undefined;
  /** Resolve credential placeholders in headers. */
  resolveHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>>;
  /** Auto-discover auth for servers without explicit headers. Receives the
   *  per-request agentId + userId so the implementation can look up
   *  tuple-keyed skill credentials. */
  authForServer?: (server: {
    name: string;
    url: string;
    agentId: string;
    userId: string;
  }) => Promise<Record<string, string> | undefined>;
}

export class ToolDispatcher {
  constructor(private readonly opts: ToolDispatcherOptions) {}

  async dispatch(call: DispatchCall, ctx: DispatchContext): Promise<DispatchResult> {
    const serverUrl = this.opts.resolveServer(ctx.agentId, call.tool);
    if (!serverUrl) {
      return {
        content: `Unknown tool: "${call.tool}". No MCP server or API endpoint registered for this tool.`,
        isError: true,
      };
    }

    // Resolve auth headers
    let headers: Record<string, string> | undefined;
    try {
      if (this.opts.getServerMeta) {
        const meta = this.opts.getServerMeta(ctx.agentId, serverUrl);
        if (meta?.headers) {
          headers = this.opts.resolveHeaders
            ? await this.opts.resolveHeaders(meta.headers)
            : meta.headers;
        }
        if (!headers && this.opts.authForServer && meta?.name) {
          headers = await this.opts.authForServer({
            name: meta.name,
            url: serverUrl,
            agentId: ctx.agentId,
            userId: ctx.userId,
          });
        }
      }
    } catch {
      // Header resolution failure should not block the tool call
    }

    try {
      const result = await this.opts.callTool(
        serverUrl, call.tool, call.args,
        headers ? { headers } : undefined,
      );

      const content = typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);

      if (Buffer.byteLength(content) > DISPATCH_LIMITS.maxResultSizeBytes) {
        return {
          content: `Tool result too large (>${DISPATCH_LIMITS.maxResultSizeBytes} bytes). Ask for a smaller response.`,
          isError: true,
        };
      }

      return {
        content,
        isError: result.isError,
        taint: { source: `external:${serverUrl}`, trust: 'external' as const, timestamp: new Date() },
      };
    } catch (err) {
      logger.warn('dispatch_error', { tool: call.tool, error: (err as Error).message });
      return {
        content: `Tool call failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

}
