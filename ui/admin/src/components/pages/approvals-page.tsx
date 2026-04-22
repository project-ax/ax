import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sparkles,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  Globe,
  Server,
  CheckCircle2,
  Loader2,
  Trash2,
  ExternalLink,
  Plus,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type {
  SetupCard,
  SetupCardCredential,
  SkillApproveBody,
  SkillProbeFailure,
  SkillSetupResponse,
} from '../../lib/types';

// ── Setup card ──
//
// Every field on a pending skill is editable here. The dashboard posts the
// full intended frontmatter back to the host, which probes each MCP server
// with the admin's (typed or already-stored) credentials and — only on a
// clean probe — rewrites SKILL.md in the agent's repo + persists creds +
// approves domains. One button press, one atomic commit.

interface SetupCardViewProps {
  agentId: string;
  card: SetupCard;
  onChange: () => void;
}

/** Editable draft of a credential — mirrors SetupCardCredential minus the
 *  server-provided `hasExistingValue` hint (that stays on the source card
 *  and drives the "reusing existing" label). */
interface CredentialDraft {
  envName: string;
  authType: 'api_key' | 'oauth';
  scope: 'user' | 'agent';
  oauth?: SetupCardCredential['oauth'];
}

interface McpServerDraft {
  name: string;
  url: string;
  transport: 'http' | 'sse';
  credential: string;
}

function SetupCardView({ agentId, card, onChange }: SetupCardViewProps) {
  // ── Editable drafts — initialized from the card, updated as the admin
  // types. The `originalCard` copy is kept so we can tell which fields
  // actually changed when we post.
  const [credentialDrafts, setCredentialDrafts] = useState<CredentialDraft[]>(() =>
    card.credentials.map((c) => ({
      envName: c.envName,
      authType: c.authType,
      scope: c.scope,
      oauth: c.oauth,
    })),
  );
  const [mcpServerDrafts, setMcpServerDrafts] = useState<McpServerDraft[]>(() =>
    card.mcpServers.map((s) => ({
      name: s.name,
      url: s.url,
      transport: s.transport,
      credential: s.credential ?? '',
    })),
  );
  // Domain drafts — full list (approved + new). An admin can delete any
  // entry or add new ones. On submit we post the union of what's here.
  const [domainDrafts, setDomainDrafts] = useState<string[]>(() =>
    card.domains.map((d) => d.domain),
  );
  const [newDomain, setNewDomain] = useState<string>('');

  // Typed credential values, keyed by CURRENT envName in the draft. When
  // the admin renames an envName in the draft, the typed value follows.
  // Map keys stay in sync via the onChange for envName below.
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of card.credentials) init[c.envName] = '';
    return init;
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probeFailures, setProbeFailures] = useState<SkillProbeFailure[]>([]);
  const [success, setSuccess] = useState(false);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const [connectError, setConnectError] = useState<Record<string, string>>({});
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      for (const t of connectTimersRef.current.values()) clearTimeout(t);
      connectTimersRef.current.clear();
    };
  }, []);

  // Derived flags — OAuth creds still listed in missingCredentials haven't
  // been connected yet; the button stays disabled until every OAuth cred
  // on the card is handled. (OAuth entries skip the probe path server-side,
  // but we still block Approve until they're connected or removed.)
  const hasUnconnectedOAuth = credentialDrafts.some((c) => {
    if (c.authType !== 'oauth') return false;
    const sourceCred = card.missingCredentials.find((m) => m.envName === c.envName);
    return sourceCred !== undefined;
  });

  // An api_key draft blocks submit if the user hasn't typed a value AND
  // the server doesn't have one to reuse under its current envName. If
  // the admin renamed the envName, `hasExistingValue` (keyed on the
  // ORIGINAL envName) no longer applies — require a typed value.
  const missingApiKeyValue = credentialDrafts.some((draft) => {
    if (draft.authType !== 'api_key') return false;
    const typed = (credentialValues[draft.envName] ?? '').trim();
    if (typed !== '') return false;
    const sourceCred = card.credentials.find((c) => c.envName === draft.envName);
    return !sourceCred?.hasExistingValue;
  });

  const submitDisabled =
    submitting || success || hasUnconnectedOAuth || missingApiKeyValue;

  const updateCredentialDraft = useCallback(
    (idx: number, patch: Partial<CredentialDraft>) => {
      setCredentialDrafts((prev) => {
        const next = [...prev];
        const old = next[idx];
        next[idx] = { ...old, ...patch };
        // When envName is renamed, carry the typed value over to the new
        // key so the admin doesn't have to retype. Also propagate the
        // rename into any mcpServer.credential references that pointed
        // at the old envName.
        if (patch.envName !== undefined && patch.envName !== old.envName) {
          setCredentialValues((vals) => {
            const copy = { ...vals };
            copy[patch.envName!] = copy[old.envName] ?? '';
            delete copy[old.envName];
            return copy;
          });
          setMcpServerDrafts((servers) =>
            servers.map((s) =>
              s.credential === old.envName ? { ...s, credential: patch.envName! } : s,
            ),
          );
        }
        return next;
      });
    },
    [],
  );

  const updateMcpServerDraft = useCallback(
    (idx: number, patch: Partial<McpServerDraft>) => {
      setMcpServerDrafts((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], ...patch };
        return next;
      });
    },
    [],
  );

  const setCredentialValue = useCallback((envName: string, value: string) => {
    setCredentialValues((prev) => ({ ...prev, [envName]: value }));
  }, []);

  const removeDomain = useCallback((domain: string) => {
    setDomainDrafts((prev) => prev.filter((d) => d !== domain));
  }, []);

  const addDomain = useCallback(() => {
    const trimmed = newDomain.trim().toLowerCase();
    if (!trimmed || domainDrafts.includes(trimmed)) {
      setNewDomain('');
      return;
    }
    setDomainDrafts((prev) => [...prev, trimmed]);
    setNewDomain('');
  }, [newDomain, domainDrafts]);

  const handleTestAndEnable = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setProbeFailures([]);

    const body: SkillApproveBody = {
      agentId,
      skillName: card.skillName,
      frontmatter: {
        credentials: credentialDrafts.map((c) => ({
          envName: c.envName,
          authType: c.authType,
          scope: c.scope,
          ...(c.oauth ? { oauth: c.oauth } : {}),
        })),
        mcpServers: mcpServerDrafts.map((s) => ({
          name: s.name,
          url: s.url,
          transport: s.transport,
          ...(s.credential ? { credential: s.credential } : {}),
        })),
        domains: domainDrafts,
      },
      credentialValues: credentialDrafts
        .filter((c) => c.authType === 'api_key')
        .map((c) => ({
          envName: c.envName,
          value: credentialValues[c.envName] ?? '',
        })),
    };

    try {
      await api.approveSkill(body);
      setSubmitting(false);
      setSuccess(true);
      successTimerRef.current = setTimeout(() => {
        onChange();
      }, 1500);
    } catch (err) {
      setSubmitting(false);
      const e = err as Error & {
        details?: string;
        probeFailures?: SkillProbeFailure[];
      };
      setError(e instanceof Error ? e.message : String(err));
      if (e.probeFailures?.length) {
        setProbeFailures(e.probeFailures);
      }
    }
  }, [
    agentId,
    card.skillName,
    credentialDrafts,
    credentialValues,
    domainDrafts,
    mcpServerDrafts,
    onChange,
  ]);

  const handleConnect = useCallback(
    async (envName: string) => {
      setConnectError((prev) => {
        const next = { ...prev };
        delete next[envName];
        return next;
      });
      setConnecting((prev) => {
        const next = new Set(prev);
        next.add(envName);
        return next;
      });
      try {
        const { authUrl } = await api.startOAuth({
          agentId,
          skillName: card.skillName,
          envName,
        });
        const win = window.open(authUrl, '_blank', 'noopener,noreferrer');
        if (!win) {
          setConnectError((prev) => ({
            ...prev,
            [envName]: 'Pop-up blocked. Allow pop-ups and try again.',
          }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to start OAuth flow';
        setConnectError((prev) => ({ ...prev, [envName]: msg }));
      } finally {
        const prevTimer = connectTimersRef.current.get(envName);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          setConnecting((prev) => {
            const next = new Set(prev);
            next.delete(envName);
            return next;
          });
          connectTimersRef.current.delete(envName);
        }, 30_000);
        connectTimersRef.current.set(envName, t);
      }
    },
    [agentId, card.skillName],
  );

  const handleDismissClick = useCallback(async () => {
    if (confirmingDismiss) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmingDismiss(false);
      try {
        await api.dismissSkill(agentId, card.skillName);
        onChange();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } else {
      setConfirmingDismiss(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmingDismiss(false);
      }, 3000);
    }
  }, [agentId, card.skillName, confirmingDismiss, onChange]);

  const probeFailureByServer = new Map<string, string>();
  for (const f of probeFailures) probeFailureByServer.set(f.name, f.error);

  return (
    <div className="card" data-testid={`setup-card-${card.skillName}`}>
      <div className="card-header flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[14px] font-semibold tracking-tight text-foreground">
              {card.skillName}
            </h4>
            <span className="inline-flex items-center gap-1 rounded-full border border-amber/20 bg-amber/5 px-2 py-0.5 text-[10px] font-medium text-amber">
              Setup Required
            </span>
          </div>
          {card.description && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              {card.description}
            </p>
          )}
        </div>
      </div>

      <div className="card-body space-y-5">
        {/* Credentials */}
        {credentialDrafts.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert size={14} className="text-amber" strokeWidth={1.8} />
              <h5 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Credentials
              </h5>
            </div>
            <div className="space-y-3">
              {credentialDrafts.map((cred, idx) => {
                const sourceCred = card.credentials.find((c) => c.envName === cred.envName);
                const hasExistingValue = sourceCred?.hasExistingValue ?? false;
                return (
                  <div
                    key={`${idx}`}
                    className="rounded-lg border border-border/40 bg-foreground/[0.02] p-3 space-y-2"
                  >
                    <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                      <input
                        type="text"
                        value={cred.envName}
                        onChange={(e) =>
                          updateCredentialDraft(idx, {
                            envName: e.target.value.toUpperCase(),
                          })
                        }
                        placeholder="ENV_NAME"
                        className="input font-mono text-[12px]"
                      />
                      <select
                        value={cred.authType}
                        onChange={(e) =>
                          updateCredentialDraft(idx, {
                            authType: e.target.value as 'api_key' | 'oauth',
                          })
                        }
                        className="input text-[12px]"
                      >
                        <option value="api_key">api_key</option>
                        <option value="oauth">oauth</option>
                      </select>
                      <select
                        value={cred.scope}
                        onChange={(e) =>
                          updateCredentialDraft(idx, {
                            scope: e.target.value as 'user' | 'agent',
                          })
                        }
                        className="input text-[12px]"
                      >
                        <option value="user">user-scoped</option>
                        <option value="agent">agent-scoped</option>
                      </select>
                    </div>
                    {cred.authType === 'oauth' ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground flex-1">
                          Connect via {cred.oauth?.provider ?? 'provider'}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleConnect(cred.envName)}
                          disabled={
                            connecting.has(cred.envName) || submitting || success
                          }
                          className="btn-secondary text-[12px] flex items-center gap-1.5"
                        >
                          {connecting.has(cred.envName) ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              Opening...
                            </>
                          ) : (
                            <>
                              <ExternalLink size={12} />
                              Connect
                            </>
                          )}
                        </button>
                      </div>
                    ) : (
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          hasExistingValue
                            ? 'Leave blank to reuse existing'
                            : 'Paste token here'
                        }
                        value={credentialValues[cred.envName] ?? ''}
                        onChange={(e) =>
                          setCredentialValue(cred.envName, e.target.value)
                        }
                        className="input w-full text-[12px]"
                      />
                    )}
                    {connectError[cred.envName] && (
                      <p className="text-[11px] text-rose">{connectError[cred.envName]}</p>
                    )}
                    {hasExistingValue && cred.authType === 'api_key' && (
                      <p className="text-[11px] text-emerald/80">
                        Reusing existing value for {cred.envName}; paste a new one to replace.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* MCP servers */}
        {mcpServerDrafts.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <Server size={14} className="text-violet" strokeWidth={1.8} />
              <h5 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                MCP Servers
              </h5>
            </div>
            <div className="space-y-3">
              {mcpServerDrafts.map((srv, idx) => {
                const probeError = probeFailureByServer.get(srv.name);
                return (
                  <div
                    key={idx}
                    className={`rounded-lg border p-3 space-y-2 ${
                      probeError ? 'border-rose/30 bg-rose/[0.03]' : 'border-border/40 bg-foreground/[0.02]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[12px] text-foreground/90">
                        {srv.name}
                      </span>
                      <select
                        value={srv.transport}
                        onChange={(e) =>
                          updateMcpServerDraft(idx, {
                            transport: e.target.value as 'http' | 'sse',
                          })
                        }
                        className="input text-[11px] ml-auto"
                      >
                        <option value="http">http</option>
                        <option value="sse">sse</option>
                      </select>
                    </div>
                    <input
                      type="text"
                      value={srv.url}
                      onChange={(e) => updateMcpServerDraft(idx, { url: e.target.value })}
                      placeholder="https://..."
                      className="input w-full font-mono text-[11px]"
                    />
                    {credentialDrafts.length > 0 && (
                      <select
                        value={srv.credential}
                        onChange={(e) =>
                          updateMcpServerDraft(idx, { credential: e.target.value })
                        }
                        className="input text-[11px] w-full"
                      >
                        <option value="">(no credential)</option>
                        {credentialDrafts.map((c) => (
                          <option key={c.envName} value={c.envName}>
                            credential: {c.envName}
                          </option>
                        ))}
                      </select>
                    )}
                    {probeError && (
                      <div className="flex items-start gap-2 mt-2">
                        <AlertTriangle size={12} className="text-rose shrink-0 mt-0.5" />
                        <p className="text-[11px] text-rose font-mono break-words">
                          {probeError}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Domains */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Globe size={14} className="text-sky" strokeWidth={1.8} />
            <h5 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Network Access
            </h5>
          </div>
          <p className="text-[12px] text-muted-foreground mb-2">
            Hostnames the skill will reach. Remove ones the skill shouldn't need; add
            any that got missed.
          </p>
          {domainDrafts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No domains declared.</p>
          ) : (
            <ul className="space-y-1.5 mb-2">
              {domainDrafts.map((domain) => (
                <li
                  key={domain}
                  className="flex items-center gap-2 rounded-lg border border-border/40 bg-foreground/[0.02] px-2.5 py-1.5"
                >
                  <span className="font-mono text-[12px] text-foreground/90 flex-1 truncate">
                    {domain}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeDomain(domain)}
                    className="text-muted-foreground hover:text-rose p-0.5"
                    title="Remove domain"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDomain();
                }
              }}
              placeholder="Add a domain (e.g. api.example.com)"
              className="input flex-1 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={addDomain}
              disabled={!newDomain.trim()}
              className="btn-secondary text-[11px] flex items-center gap-1"
            >
              <Plus size={12} />
              Add
            </button>
          </div>
        </section>

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-rose/5 border border-rose/15">
            <AlertTriangle size={14} className="text-rose shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[13px] text-rose font-medium break-words">{error}</p>
              {probeFailures.length === 0 && (
                <p className="mt-0.5 text-[11px] text-rose/70 break-words">
                  Fix the highlighted fields and click Test & Enable again.
                </p>
              )}
              {probeFailures.length > 0 && (
                <p className="mt-0.5 text-[11px] text-rose/70">
                  Each failing MCP server shows its error above — common fixes: correct
                  the URL path, flip the transport (http ↔ sse), or supply the right
                  credential.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/30">
          <button
            onClick={handleDismissClick}
            className="btn-danger text-[13px] flex items-center gap-1.5"
            disabled={submitting || success}
          >
            <Trash2 size={13} />
            {confirmingDismiss ? 'Confirm dismiss?' : 'Dismiss'}
          </button>
          <div className="flex items-center gap-3">
            {success && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald">
                <CheckCircle2 size={14} />
                Enabled
              </span>
            )}
            <button
              onClick={handleTestAndEnable}
              disabled={submitDisabled}
              className="btn-primary text-[13px] flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} />
                  Test &amp; Enable
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ── Page ──

export default function ApprovalsPage() {
  const {
    data: setup,
    loading: setupLoading,
    error: setupError,
    refresh: refreshSetup,
  } = useApi<SkillSetupResponse>(() => api.skillsSetup(), []);

  const handleRefresh = useCallback(() => {
    refreshSetup();
  }, [refreshSetup]);

  // Auto-poll /skills/setup every 2s while at least one card has an
  // unconnected OAuth credential — the callback endpoint writes the cred
  // and polling drops the card (or the cred) from the queue.
  useEffect(() => {
    const anyOAuth =
      setup?.agents?.some((a) =>
        a.cards?.some((c) =>
          c.missingCredentials.some((mc) => mc.authType === 'oauth'),
        ),
      ) ?? false;
    if (!anyOAuth) return;

    const id = setInterval(() => {
      refreshSetup();
    }, 2000);
    return () => clearInterval(id);
  }, [setup, refreshSetup]);

  const fatalError = setupError;
  if (fatalError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load approvals
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4">{fatalError.message}</p>
        <button onClick={handleRefresh} className="btn-primary flex items-center gap-2">
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  const agentGroups = setup?.agents ?? [];
  const loading = setupLoading && !setup;
  const nothingPending = agentGroups.length === 0;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between animate-fade-in-up">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-amber" strokeWidth={1.8} />
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Approvals
            </h2>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground max-w-2xl">
            Pending skills need credentials, the right MCP endpoint, and some
            hostnames on the allowlist. Edit anything the agent got wrong, paste
            the API key, and we'll probe the MCP server before enabling — so a
            skill that shows up here green is a skill that already works.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          className="btn-secondary flex items-center gap-2 text-[13px]"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      )}

      {!loading && agentGroups.length > 0 && (
        <section className="space-y-6">
          <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
            Setup Required
          </h3>
          {agentGroups.map((group) => (
            <div key={group.agentId} className="space-y-3">
              <h4 className="text-[13px] font-medium text-muted-foreground">
                {group.agentName}
              </h4>
              <div className="space-y-3">
                {group.cards.map((card) => (
                  <SetupCardView
                    key={`${group.agentId}-${card.skillName}`}
                    agentId={group.agentId}
                    card={card}
                    onChange={handleRefresh}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {!loading && nothingPending && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald/5 border border-emerald/15 mb-4">
            <CheckCircle2 size={22} className="text-emerald" strokeWidth={1.8} />
          </div>
          <h3 className="text-[14px] font-semibold text-foreground mb-1">
            Nothing to approve. Nice.
          </h3>
          <p className="text-[13px] text-muted-foreground max-w-md">
            Every installed skill is set up and happy.
          </p>
        </div>
      )}
    </div>
  );
}
