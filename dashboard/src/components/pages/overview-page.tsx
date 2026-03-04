import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  Users,
  Shield,
  Clock,
  Zap,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { ServerStatus, Agent, AuditEntry } from '../../lib/types';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString();
}

function ResultBadge({ result }: { result: string }) {
  switch (result) {
    case 'ok':
      return (
        <span className="badge-green">
          <CheckCircle size={12} className="mr-1" />
          ok
        </span>
      );
    case 'error':
      return (
        <span className="badge-red">
          <XCircle size={12} className="mr-1" />
          error
        </span>
      );
    case 'blocked':
      return (
        <span className="badge-yellow">
          <AlertTriangle size={12} className="mr-1" />
          blocked
        </span>
      );
    default:
      return <span className="badge-zinc">{result}</span>;
  }
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <span className="badge-green">running</span>;
    case 'idle':
      return <span className="badge-blue">idle</span>;
    case 'stopped':
      return <span className="badge-zinc">stopped</span>;
    case 'error':
      return <span className="badge-red">error</span>;
    default:
      return <span className="badge-zinc">{status}</span>;
  }
}

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  loading: boolean;
}) {
  return (
    <div className="card">
      <div className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-zinc-800">
            <Icon size={18} className="text-amber-500" />
          </div>
          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wide">
              {label}
            </p>
            {loading ? (
              <div className="skeleton h-6 w-16 mt-1" />
            ) : (
              <p className="text-xl font-semibold text-zinc-100">{value}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useApi<ServerStatus>(() => api.status(), []);

  const { data: agents, loading: agentsLoading } = useApi<Agent[]>(
    () => api.agents(),
    []
  );

  const { data: audit, loading: auditLoading } = useApi<AuditEntry[]>(
    () => api.audit({ limit: 20 }),
    []
  );

  // Poll agents every 5 seconds
  const [liveAgents, setLiveAgents] = useState<Agent[] | null>(null);

  const pollAgents = useCallback(async () => {
    try {
      const result = await api.agents();
      setLiveAgents(result);
    } catch {
      // Silently ignore poll failures
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(pollAgents, 5000);
    return () => clearInterval(interval);
  }, [pollAgents]);

  const displayAgents = liveAgents ?? agents;
  const activeAgents = displayAgents?.filter((a) => a.status === 'running');

  if (statusError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-zinc-100 mb-2">
          Connection Error
        </h2>
        <p className="text-sm text-zinc-400 mb-4 max-w-md">
          {statusError.message}
        </p>
        <button onClick={refreshStatus} className="btn-primary">
          <RefreshCw size={14} className="inline mr-2" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-zinc-100">Overview</h2>
          <p className="text-sm text-zinc-500">
            System health and recent activity
          </p>
        </div>
        <button
          onClick={refreshStatus}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Users}
          label="Active Agents"
          value={
            status ? `${status.agents.active} / ${status.agents.total}` : '--'
          }
          loading={statusLoading}
        />
        <StatCard
          icon={Clock}
          label="Uptime"
          value={status ? formatUptime(status.uptime) : '--'}
          loading={statusLoading}
        />
        <StatCard
          icon={Shield}
          label="Security Profile"
          value={status?.profile ?? '--'}
          loading={statusLoading}
        />
        <StatCard
          icon={Zap}
          label="Total Events"
          value={audit ? String(audit.length) : '--'}
          loading={auditLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live agents */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">
              Live Agents
            </h3>
            {activeAgents && (
              <span className="text-xs text-zinc-500">
                {activeAgents.length} active
              </span>
            )}
          </div>
          <div className="card-body">
            {agentsLoading && !displayAgents ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : !displayAgents || displayAgents.length === 0 ? (
              <div className="text-center py-8 text-sm text-zinc-500">
                No agents running
              </div>
            ) : (
              <div className="space-y-2">
                {displayAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center justify-between p-3 rounded-md bg-zinc-800/50 hover:bg-zinc-800 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          agent.status === 'running'
                            ? 'bg-green-400 animate-pulse'
                            : agent.status === 'error'
                              ? 'bg-red-400'
                              : 'bg-zinc-500'
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-200 truncate">
                          {agent.name}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {agent.agentType}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={agent.status} />
                      <ChevronRight size={14} className="text-zinc-600" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">
              Recent Activity
            </h3>
            {audit && (
              <span className="text-xs text-zinc-500">
                Last {audit.length} events
              </span>
            )}
          </div>
          <div className="card-body">
            {auditLoading && !audit ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="skeleton h-10 w-full" />
                ))}
              </div>
            ) : !audit || audit.length === 0 ? (
              <div className="text-center py-8 text-sm text-zinc-500">
                No activity recorded yet
              </div>
            ) : (
              <div className="space-y-1">
                {audit.slice(0, 20).map((entry, i) => (
                  <div
                    key={`${entry.timestamp}-${i}`}
                    className="flex items-center justify-between py-2 px-2 rounded hover:bg-zinc-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ResultBadge result={entry.result} />
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-300 truncate">
                          {entry.action}
                        </p>
                        <p className="text-xs text-zinc-600">
                          {entry.sessionId.slice(0, 8)}...
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-zinc-500">
                        {formatTimestamp(entry.timestamp)}
                      </p>
                      <p className="text-xs text-zinc-600">
                        {entry.durationMs}ms
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
