import {
  Settings,
  Server,
  Shield,
  RefreshCw,
  AlertTriangle,
  Clock,
  Key,
  Terminal,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { ServerStatus, ServerConfig } from '../../lib/types';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function ConfigSection({
  title,
  icon: Icon,
  data,
}: {
  title: string;
  icon: typeof Settings;
  data: Record<string, unknown> | undefined;
}) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="card">
        <div className="card-header flex items-center gap-2">
          <Icon size={16} className="text-amber-500" />
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        </div>
        <div className="card-body">
          <p className="text-sm text-zinc-500">No configuration set</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header flex items-center gap-2">
        <Icon size={16} className="text-amber-500" />
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      </div>
      <div className="card-body">
        <div className="space-y-2">
          {Object.entries(data).map(([key, value]) => (
            <div
              key={key}
              className="flex items-start justify-between py-1.5 border-b border-zinc-800/50 last:border-0"
            >
              <span className="text-sm text-zinc-400 font-mono">{key}</span>
              <span className="text-sm text-zinc-300 text-right ml-4 break-all">
                {typeof value === 'object' && value !== null
                  ? JSON.stringify(value, null, 0)
                  : String(value ?? '--')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useApi<ServerStatus>(() => api.status(), []);

  const {
    data: config,
    loading: configLoading,
    error: configError,
    refresh: refreshConfig,
  } = useApi<ServerConfig>(() => api.config(), []);

  const error = statusError || configError;
  const loading = statusLoading || configLoading;

  const handleRefresh = () => {
    refreshStatus();
    refreshConfig();
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-zinc-100 mb-2">
          Failed to load settings
        </h2>
        <p className="text-sm text-zinc-400 mb-4">{error.message}</p>
        <button onClick={handleRefresh} className="btn-primary">
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
          <h2 className="text-xl font-bold text-zinc-100">Settings</h2>
          <p className="text-sm text-zinc-500">
            Server configuration (read-only)
          </p>
        </div>
        <button
          onClick={handleRefresh}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Notice */}
      <div className="card border-amber-500/20">
        <div className="p-4 flex items-start gap-3">
          <AlertTriangle
            size={18}
            className="text-amber-500 shrink-0 mt-0.5"
          />
          <div>
            <p className="text-sm text-zinc-300">
              Configuration is read-only in the dashboard. To make changes, edit
              your{' '}
              <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-amber-400 text-xs font-mono">
                ax.yaml
              </code>{' '}
              file and restart the server.
            </p>
          </div>
        </div>
      </div>

      {/* Server info */}
      <div className="card">
        <div className="card-header flex items-center gap-2">
          <Server size={16} className="text-amber-500" />
          <h3 className="text-sm font-semibold text-zinc-100">
            Server Information
          </h3>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton h-8 w-full" />
              ))}
            </div>
          ) : status ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-center gap-3 p-3 rounded bg-zinc-800/50">
                <div className="p-1.5 rounded bg-zinc-700">
                  <Server size={14} className="text-zinc-400" />
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Status</p>
                  <p className="text-sm font-medium text-zinc-200">
                    {status.status}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded bg-zinc-800/50">
                <div className="p-1.5 rounded bg-zinc-700">
                  <Clock size={14} className="text-zinc-400" />
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Uptime</p>
                  <p className="text-sm font-medium text-zinc-200">
                    {formatUptime(status.uptime)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded bg-zinc-800/50">
                <div className="p-1.5 rounded bg-zinc-700">
                  <Shield size={14} className="text-zinc-400" />
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Security Profile</p>
                  <p className="text-sm font-medium text-zinc-200 capitalize">
                    {status.profile}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded bg-zinc-800/50">
                <div className="p-1.5 rounded bg-zinc-700">
                  <Terminal size={14} className="text-zinc-400" />
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Agents</p>
                  <p className="text-sm font-medium text-zinc-200">
                    {status.agents.active} active / {status.agents.total} total
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Configuration sections */}
      {configLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      ) : config ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ConfigSection
            title="Security Profile"
            icon={Shield}
            data={{ profile: config.profile }}
          />
          <ConfigSection
            title="Providers"
            icon={Key}
            data={
              config.providers as Record<string, unknown> | undefined
            }
          />
          <ConfigSection
            title="Sandbox"
            icon={Terminal}
            data={
              config.sandbox as Record<string, unknown> | undefined
            }
          />
          <ConfigSection
            title="Scheduler"
            icon={Clock}
            data={
              config.scheduler as Record<string, unknown> | undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
