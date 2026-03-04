import {
  Shield,
  AlertTriangle,
  RefreshCw,
  CheckCircle,
  XCircle,
  Eye,
  Activity,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { ServerStatus, AuditEntry } from '../../lib/types';

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

function ProfileCard({ profile }: { profile: string }) {
  const configs: Record<
    string,
    { color: string; description: string; icon: typeof Shield }
  > = {
    paranoid: {
      color: 'text-red-400 bg-red-500/10 border-red-500/20',
      description:
        'Maximum security. Every operation is scrutinized. No network access for agents. All content is taint-tagged.',
      icon: Shield,
    },
    balanced: {
      color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
      description:
        'Reasonable defaults. Network restricted to allowlisted domains. Content tainting enabled for external sources.',
      icon: Eye,
    },
    yolo: {
      color: 'text-green-400 bg-green-500/10 border-green-500/20',
      description:
        'Minimal restrictions. Use only in trusted development environments. Not recommended for production.',
      icon: Activity,
    },
  };

  const config = configs[profile] || configs['balanced'];
  const Icon = config.icon;

  return (
    <div className={`card border ${config.color.split(' ')[2]}`}>
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <div
            className={`p-2 rounded-md ${config.color.split(' ')[1]}`}
          >
            <Icon size={20} className={config.color.split(' ')[0]} />
          </div>
          <div>
            <h3 className="font-semibold text-zinc-100 capitalize">
              {profile}
            </h3>
            <p className="text-xs text-zinc-500">Active Security Profile</p>
          </div>
        </div>
        <p className="text-sm text-zinc-400">{config.description}</p>
      </div>
    </div>
  );
}

function ThreatEntry({ entry }: { entry: AuditEntry }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-md bg-zinc-800/50 hover:bg-zinc-800 transition-colors">
      <div className="p-1.5 rounded bg-red-500/10 shrink-0 mt-0.5">
        <AlertTriangle size={14} className="text-red-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-zinc-200 truncate">
            {entry.action}
          </p>
          <span className="text-xs text-zinc-500 shrink-0">
            {formatTimestamp(entry.timestamp)}
          </span>
        </div>
        <p className="text-xs text-zinc-500 mt-0.5">
          Session: {entry.sessionId.slice(0, 12)}...
        </p>
        {entry.args && Object.keys(entry.args).length > 0 && (
          <div className="mt-1.5 p-2 rounded bg-zinc-900 font-mono text-xs text-zinc-400 break-all">
            {JSON.stringify(entry.args, null, 0).slice(0, 200)}
            {JSON.stringify(entry.args).length > 200 && '...'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useApi<ServerStatus>(() => api.status(), []);

  // Security scan events
  const {
    data: scanEvents,
    loading: scansLoading,
  } = useApi<AuditEntry[]>(
    () => api.audit({ action: 'scan', limit: 50 }),
    []
  );

  // Blocked/threat events
  const {
    data: blockedEvents,
    loading: blockedLoading,
  } = useApi<AuditEntry[]>(
    () => api.audit({ result: 'blocked', limit: 50 }),
    []
  );

  if (statusError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-zinc-100 mb-2">
          Failed to load security data
        </h2>
        <p className="text-sm text-zinc-400 mb-4">{statusError.message}</p>
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
          <h2 className="text-xl font-bold text-zinc-100">Security</h2>
          <p className="text-sm text-zinc-500">
            Security profile, scans, and threat monitoring
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

      {/* Security profile */}
      {statusLoading ? (
        <div className="skeleton h-28 w-full" />
      ) : status ? (
        <ProfileCard profile={status.profile} />
      ) : null}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card">
          <div className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-md bg-zinc-800">
              <Eye size={18} className="text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide">
                Scans
              </p>
              {scansLoading ? (
                <div className="skeleton h-6 w-12 mt-1" />
              ) : (
                <p className="text-xl font-semibold text-zinc-100">
                  {scanEvents?.length ?? 0}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-md bg-zinc-800">
              <AlertTriangle size={18} className="text-red-400" />
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide">
                Blocked
              </p>
              {blockedLoading ? (
                <div className="skeleton h-6 w-12 mt-1" />
              ) : (
                <p className="text-xl font-semibold text-zinc-100">
                  {blockedEvents?.length ?? 0}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-md bg-zinc-800">
              <CheckCircle size={18} className="text-green-400" />
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide">
                Clean Scans
              </p>
              {scansLoading ? (
                <div className="skeleton h-6 w-12 mt-1" />
              ) : (
                <p className="text-xl font-semibold text-zinc-100">
                  {scanEvents?.filter((e) => e.result === 'ok').length ?? 0}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Threat patterns (blocked events) */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-400" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Threat Patterns
              </h3>
            </div>
            {blockedEvents && (
              <span className="text-xs text-zinc-500">
                {blockedEvents.length} blocked
              </span>
            )}
          </div>
          <div className="card-body">
            {blockedLoading && !blockedEvents ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-16 w-full" />
                ))}
              </div>
            ) : !blockedEvents || blockedEvents.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle
                  size={32}
                  className="text-green-500/50 mx-auto mb-3"
                />
                <p className="text-sm text-zinc-500">
                  No threats detected. The nervous crab approves.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {blockedEvents.slice(0, 20).map((entry, i) => (
                  <ThreatEntry
                    key={`${entry.timestamp}-${i}`}
                    entry={entry}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Security scan events */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye size={16} className="text-amber-500" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Security Scans
              </h3>
            </div>
            {scanEvents && (
              <span className="text-xs text-zinc-500">
                {scanEvents.length} scans
              </span>
            )}
          </div>
          <div className="card-body">
            {scansLoading && !scanEvents ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : !scanEvents || scanEvents.length === 0 ? (
              <div className="text-center py-8 text-sm text-zinc-500">
                No security scans recorded yet
              </div>
            ) : (
              <div className="space-y-1">
                {scanEvents.slice(0, 20).map((entry, i) => (
                  <div
                    key={`${entry.timestamp}-${i}`}
                    className="flex items-center justify-between py-2 px-2 rounded hover:bg-zinc-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {entry.result === 'ok' ? (
                        <CheckCircle
                          size={14}
                          className="text-green-400 shrink-0"
                        />
                      ) : (
                        <XCircle
                          size={14}
                          className="text-red-400 shrink-0"
                        />
                      )}
                      <div>
                        <p className="text-sm text-zinc-300 font-mono">
                          {entry.action}
                        </p>
                        <p className="text-xs text-zinc-600">
                          {entry.sessionId.slice(0, 8)}...
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
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
