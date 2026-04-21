import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { IIPCClient } from './runner.js';
import { TOOL_CATALOG, filterTools } from './tool-catalog.js';
import type { ToolFilterContext } from './tool-catalog.js';
import { createLocalSandbox } from './local-sandbox.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

export interface IPCToolsOptions {
  /** Current user ID (kept for backward compatibility). */
  userId?: string;
  /** Tool filter context — excludes tools irrelevant to the current session. */
  filter?: ToolFilterContext;
  /** When set, sandbox tools execute locally with host audit gate. */
  localSandbox?: { client: IIPCClient; workspace: string; sessionId?: string };
}

/** Create tools that route through IPC to the host process. */
export function createIPCTools(client: IIPCClient, opts?: IPCToolsOptions): AgentTool[] {
  async function ipcCall(action: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    try {
      const result = await client.call({ action, ...params }, timeoutMs);
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      return text(`Error: ${(err as Error).message}`);
    }
  }

  // Lazily create local sandbox executor if configured
  const sandbox = opts?.localSandbox
    ? createLocalSandbox({ client: opts.localSandbox.client, workspace: opts.localSandbox.workspace, sessionId: opts.localSandbox.sessionId })
    : null;

  const catalog = opts?.filter ? filterTools(opts.filter) : TOOL_CATALOG;

  const builtIns: AgentTool[] = catalog.map(spec => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_id: string, params: unknown) {
      const p = params as Record<string, unknown>;
      let action: string;
      let callParams: Record<string, unknown>;

      if (spec.actionMap) {
        // Multi-op: extract type, resolve action
        const { type, ...rest } = p;
        action = spec.actionMap[type as string];
        if (!action) return text(`Error: unknown type "${type}" for tool "${spec.name}"`);
        callParams = rest;
      } else {
        // Singleton
        action = spec.singletonAction ?? spec.name;
        callParams = p;
      }

      // skill_write lands the SKILL.md in the same workspace the agent
      // container owns (and the git sidecar reads) — routing it through
      // the host would write to the host-side workspace in k8s and the
      // sidecar would never see it. Validator lives in src/skills/ so it
      // runs inside the pod.
      if (sandbox && action === 'skill_write') {
        return text(JSON.stringify(await sandbox.writeSkillFile(callParams as never)));
      }

      // Route sandbox tools to local executor when in container
      if (sandbox && spec.category === 'sandbox') {
        switch (action) {
          case 'sandbox_bash':
            return text(JSON.stringify(await sandbox.bash(callParams.command as string)));
          case 'sandbox_read_file':
            return text(JSON.stringify(await sandbox.readFile(callParams.path as string)));
          case 'sandbox_write_file':
            return text(JSON.stringify(await sandbox.writeFile(callParams.path as string, callParams.content as string)));
          case 'sandbox_edit_file':
            return text(JSON.stringify(await sandbox.editFile(callParams.path as string, callParams.old_string as string, callParams.new_string as string)));
          case 'sandbox_grep':
            return text(JSON.stringify(await sandbox.grep(
              callParams.pattern as string,
              {
                path: callParams.path as string | undefined,
                glob: callParams.glob as string | undefined,
                max_results: callParams.max_results as number | undefined,
                include_line_numbers: callParams.include_line_numbers as boolean | undefined,
                context_lines: callParams.context_lines as number | undefined,
              },
            )));
          case 'sandbox_glob':
            return text(JSON.stringify(await sandbox.glob(
              callParams.pattern as string,
              {
                path: callParams.path as string | undefined,
                max_results: callParams.max_results as number | undefined,
              },
            )));
        }
      }

      return ipcCall(action, callParams, spec.timeoutMs);
    },
  }));

  return builtIns;
}
