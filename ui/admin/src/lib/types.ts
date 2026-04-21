/** Server health and status response. */
export interface ServerStatus {
  status: string;
  uptime: number;
  profile: string;
  agents: {
    active: number;
    total: number;
  };
}

/** Agent record returned by the agents API. */
export interface Agent {
  id: string;
  name: string;
  description?: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  parentId?: string;
  agentType: string;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  children?: Agent[];
}

/** Single audit log entry. */
export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  action: string;
  args: Record<string, unknown>;
  result: 'ok' | 'error' | 'blocked' | 'timeout';
  durationMs: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
}

/** Server-Sent Event from the event stream. */
export interface StreamEvent {
  type: string;
  requestId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Params for querying audit entries. */
export interface AuditParams {
  action?: string;
  result?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sessionId?: string;
}

/** Session record. */
export interface Session {
  id: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
}

/** Server configuration (read-only view). */
export interface ServerConfig {
  profile: string;
  providers: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  scheduler: Record<string, unknown>;
  [key: string]: unknown;
}

/** Identity document from the document store. */
export interface DocumentEntry {
  key: string;
  content: string;
}

/** Workspace file entry. */
export interface WorkspaceFileEntry {
  path: string;
  size: number;
}

/** Memory entry. */
export interface MemoryEntryView {
  id?: string;
  scope: string;
  content: string;
  tags?: string[];
  createdAt?: string;
  agentId?: string;
}

/** Setup status response. */
export interface SetupStatus {
  configured: boolean;
  auth_disabled?: boolean;
  external_auth?: boolean;
}

/** Setup configuration request. */
export interface SetupRequest {
  profile: string;
  agentType: string;
  apiKey: string;
}

/** Setup configuration response. */
export interface SetupResponse {
  token: string;
}

/** MCP server record. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  headers: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** MCP server test result. */
export interface McpTestResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

// ── Skills (Phase 5) ──

/** An entry on a skill's setup card — one credential the user must provide. */
export interface SetupCardCredential {
  envName: string;
  authType: 'api_key' | 'oauth';
  scope: 'user' | 'agent';
  oauth?: {
    provider: string;
    clientId: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
  /** True when the server already has a value for this envName at any
   * matching scope. Lets the UI show a "reuse existing value" hint and
   * relax the "Approve" button-disable rule; when set, leaving the input
   * blank on submit tells the approve handler to auto-fill from storage. */
  hasExistingValue?: boolean;
}

/** A pending skill setup card for a single skill on a single agent.
 *
 *  Every field the admin is allowed to edit before enabling is carried here
 *  so the card UI is the one place the correction happens. The
 *  `test-&-enable` endpoint takes the full edited frontmatter back, probes
 *  each MCP server, and — only if every probe passes — rewrites SKILL.md
 *  in the agent's repo + persists creds + approves domains atomically. */
export interface SetupCard {
  skillName: string;
  description: string;
  /** Full credential list from frontmatter (every entry is editable: envName,
   *  authType, scope). `hasExistingValue` is decorated per-entry. */
  credentials: SetupCardCredential[];
  /** Back-compat subset: creds whose value isn't yet stored. */
  missingCredentials: SetupCardCredential[];
  /** Full declared domain list — `approved` flags what the admin has
   *  already blessed. The UI renders the full list so the admin can
   *  uncheck, remove, or add. */
  domains: Array<{ domain: string; approved: boolean }>;
  /** Back-compat subset: domains still awaiting approval. */
  unapprovedDomains: string[];
  /** MCP servers — each is fully editable (url, transport, credential ref). */
  mcpServers: Array<{
    name: string;
    url: string;
    transport: 'http' | 'sse';
    credential?: string;
  }>;
}

/** Setup cards grouped per agent. */
export interface AgentSetupGroup {
  agentId: string;
  agentName: string;
  cards: SetupCard[];
}

/** Response from GET /admin/api/skills/setup. */
export interface SkillSetupResponse {
  agents: AgentSetupGroup[];
}

/** Body for POST /admin/api/skills/setup/approve (Test & Enable).
 *
 *  The dashboard posts the FULL intended frontmatter shape — every
 *  editable section, including unedited entries — plus the admin-typed
 *  credential values. The server probes each MCP server in
 *  `frontmatter.mcpServers` using the credentials resolved from
 *  `credentialValues` (falling back to already-stored values); only when
 *  every probe succeeds does it rewrite SKILL.md, persist creds, and
 *  approve domains. */
export interface SkillApproveBody {
  agentId: string;
  skillName: string;
  frontmatter: {
    credentials: Array<{
      envName: string;
      authType: 'api_key' | 'oauth';
      scope: 'user' | 'agent';
      oauth?: {
        provider: string;
        clientId: string;
        authorizationUrl: string;
        tokenUrl: string;
        scopes: string[];
      };
    }>;
    mcpServers: Array<{
      name: string;
      url: string;
      transport: 'http' | 'sse';
      credential?: string;
    }>;
    domains: string[];
  };
  /** Values the admin typed into password inputs. Empty string = reuse
   *  whatever's already stored for this envName. */
  credentialValues: Array<{ envName: string; value: string }>;
  userId?: string;
}

/** Possible lifecycle states for a skill. */
export type SkillStateKind = 'enabled' | 'pending' | 'invalid';

/** Post-reconcile state for a skill. */
export interface SkillState {
  name: string;
  kind: SkillStateKind;
  description?: string;
  pendingReasons?: string[];
  error?: string;
}

/** Per-server probe error returned with 400 when Test-&-Enable fails. */
export interface SkillProbeFailure {
  name: string;
  error: string;
}

/** Response from POST /admin/api/skills/setup/approve (Test & Enable). */
export interface SkillApproveResponse {
  ok: boolean;
  state?: SkillState;
  /** Commit SHA on refs/heads/main after the SKILL.md rewrite. `null` when
   *  the rewritten bytes exactly matched the existing file (no-op commit). */
  commit?: string | null;
}

/** Response from GET /admin/api/agents/:agentId/skills — full list of skills the reconciler knows about for this agent. */
export interface AgentSkillsResponse {
  skills: SkillState[];
}

/** Response from POST /admin/api/skills/oauth/start. */
export interface StartOAuthResponse {
  authUrl: string;
  state: string;
}
