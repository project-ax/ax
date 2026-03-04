import { useState, useCallback } from 'react';
import {
  FileText,
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { AuditEntry, AuditParams } from '../../lib/types';

const ACTION_TYPES = [
  { value: '', label: 'All Actions' },
  { value: 'tool_call', label: 'Tool Calls' },
  { value: 'llm_request', label: 'LLM Requests' },
  { value: 'agent_spawn', label: 'Agent Spawn' },
  { value: 'agent_kill', label: 'Agent Kill' },
  { value: 'scan', label: 'Security Scans' },
  { value: 'file_read', label: 'File Read' },
  { value: 'file_write', label: 'File Write' },
  { value: 'ipc', label: 'IPC' },
];

const RESULT_TYPES = [
  { value: '', label: 'All Results' },
  { value: 'ok', label: 'OK' },
  { value: 'error', label: 'Error' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'timeout', label: 'Timeout' },
];

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
    case 'timeout':
      return (
        <span className="badge-yellow">
          <Clock size={12} className="mr-1" />
          timeout
        </span>
      );
    default:
      return <span className="badge-zinc">{result}</span>;
  }
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

export default function LogsPage() {
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);

  const buildParams = useCallback((): AuditParams => {
    const params: AuditParams = { limit };
    if (action) params.action = action;
    if (result) params.result = result;
    if (search.trim()) params.search = search.trim();
    return params;
  }, [action, result, search, limit]);

  const {
    data: entries,
    loading,
    error,
    refresh,
  } = useApi<AuditEntry[]>(() => api.audit(buildParams()), [
    action,
    result,
    search,
    limit,
  ]);

  const handleLoadMore = () => {
    setLimit((prev) => prev + 50);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-zinc-100 mb-2">
          Failed to load audit logs
        </h2>
        <p className="text-sm text-zinc-400 mb-4">{error.message}</p>
        <button onClick={refresh} className="btn-primary">
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
          <h2 className="text-xl font-bold text-zinc-100">Audit Logs</h2>
          <p className="text-sm text-zinc-500">
            System activity and event history
          </p>
        </div>
        <button
          onClick={refresh}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Filter bar */}
      <div className="card">
        <div className="p-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="select text-sm"
            >
              {ACTION_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <select
              value={result}
              onChange={(e) => setResult(e.target.value)}
              className="select text-sm"
            >
              {RESULT_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <div className="relative flex-1 min-w-[200px]">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search actions, sessions..."
                className="input w-full pl-9 text-sm"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Logs table */}
      <div className="card">
        <div className="card-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-amber-500" />
            <h3 className="text-sm font-semibold text-zinc-100">
              Log Entries
            </h3>
          </div>
          {entries && (
            <span className="text-xs text-zinc-500">
              {entries.length} entries
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          {loading && !entries ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="skeleton h-10 w-full" />
              ))}
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="text-center py-12 text-sm text-zinc-500">
              {action || result || search
                ? 'No entries match your filters'
                : 'No audit entries recorded yet'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                    Timestamp
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                    Action
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                    Session
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                    Result
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wide text-right">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {entries.map((entry, i) => (
                  <tr
                    key={`${entry.timestamp}-${i}`}
                    className="hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock size={12} className="text-zinc-600" />
                        {formatTimestamp(entry.timestamp)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-zinc-300">
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-zinc-500">
                        {entry.sessionId.slice(0, 12)}...
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ResultBadge result={entry.result} />
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400 tabular-nums">
                      {entry.durationMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Load more */}
        {entries && entries.length >= limit && (
          <div className="p-4 border-t border-zinc-800 text-center">
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="btn-secondary text-sm"
            >
              {loading ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
