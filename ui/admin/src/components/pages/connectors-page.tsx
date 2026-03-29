import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Globe,
  Plus,
  AlertTriangle,
  RefreshCw,
  CheckCircle,
  XCircle,
  Trash2,
  Pencil,
  Zap,
  Loader2,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { McpServer, McpTestResult } from '../../lib/types';

type ServerStatus = 'untested' | 'connected' | 'failed';

interface HeaderEntry {
  key: string;
  value: string;
}

function parseHeaders(headersJson: string | null): HeaderEntry[] {
  if (!headersJson) return [];
  try {
    const parsed = JSON.parse(headersJson);
    return Object.entries(parsed).map(([key, value]) => ({
      key,
      value: String(value),
    }));
  } catch {
    return [];
  }
}

function headersToRecord(entries: HeaderEntry[]): Record<string, string> | undefined {
  const filtered = entries.filter((e) => e.key.trim() !== '');
  if (filtered.length === 0) return undefined;
  const record: Record<string, string> = {};
  for (const entry of filtered) {
    record[entry.key.trim()] = entry.value;
  }
  return record;
}

export default function ConnectorsPage() {
  const {
    data: servers,
    loading,
    error,
    refresh,
  } = useApi<McpServer[]>(() => api.mcpServers(), []);

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formHeaders, setFormHeaders] = useState<HeaderEntry[]>([]);

  const [testingForm, setTestingForm] = useState(false);
  const [formTestResult, setFormTestResult] = useState<McpTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [serverStatuses, setServerStatuses] = useState<Record<string, ServerStatus>>({});
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup confirm timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const resetForm = useCallback(() => {
    setShowForm(false);
    setEditingServer(null);
    setFormName('');
    setFormUrl('');
    setFormHeaders([]);
    setTestingForm(false);
    setFormTestResult(null);
    setSaving(false);
    setFormError('');
  }, []);

  const openAddForm = useCallback(() => {
    resetForm();
    setShowForm(true);
  }, [resetForm]);

  const openEditForm = useCallback((server: McpServer) => {
    setShowForm(true);
    setEditingServer(server.name);
    setFormName(server.name);
    setFormUrl(server.url);
    setFormHeaders(parseHeaders(server.headers));
    setTestingForm(false);
    setFormTestResult(null);
    setSaving(false);
    setFormError('');
  }, []);

  const addHeaderRow = useCallback(() => {
    setFormHeaders((prev) => [...prev, { key: '', value: '' }]);
  }, []);

  const updateHeader = useCallback((index: number, field: 'key' | 'value', val: string) => {
    setFormHeaders((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: val } : entry))
    );
  }, []);

  const removeHeader = useCallback((index: number) => {
    setFormHeaders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleTestAndSave = useCallback(async () => {
    if (!formName.trim() || !formUrl.trim()) {
      setFormError('Name and URL are required.');
      return;
    }

    setFormError('');
    setFormTestResult(null);
    setTestingForm(true);

    const headers = headersToRecord(formHeaders);

    try {
      // Save first (need the server to exist before testing)
      if (editingServer) {
        await api.updateMcpServer(editingServer, { url: formUrl, headers });
      } else {
        await api.addMcpServer({ name: formName.trim(), url: formUrl.trim(), headers });
      }

      // Now test
      const result = await api.testMcpServer(editingServer ?? formName.trim());
      setTestingForm(false);
      setFormTestResult(result);

      if (result.ok) {
        setServerStatuses((prev) => ({ ...prev, [editingServer ?? formName.trim()]: 'connected' }));
        // Auto-close form on success
        setTimeout(() => {
          resetForm();
          refresh();
        }, 1200);
      } else {
        setServerStatuses((prev) => ({ ...prev, [editingServer ?? formName.trim()]: 'failed' }));
        // Refresh list since server was saved
        refresh();
      }
    } catch (err) {
      setTestingForm(false);
      setFormError(err instanceof Error ? err.message : 'Failed to save server');
    }
  }, [formName, formUrl, formHeaders, editingServer, resetForm, refresh]);

  const handleSaveAnyway = useCallback(async () => {
    // Server was already saved during test — just close the form
    resetForm();
    refresh();
  }, [resetForm, refresh]);

  const handleTestServer = useCallback(async (name: string) => {
    setTestingServer(name);
    try {
      const result = await api.testMcpServer(name);
      setServerStatuses((prev) => ({
        ...prev,
        [name]: result.ok ? 'connected' : 'failed',
      }));
    } catch {
      setServerStatuses((prev) => ({ ...prev, [name]: 'failed' }));
    } finally {
      setTestingServer(null);
    }
  }, []);

  const handleDeleteClick = useCallback(
    (name: string) => {
      if (confirmingDelete === name) {
        // Second click — actually delete
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        setConfirmingDelete(null);
        api.removeMcpServer(name).then(() => refresh());
      } else {
        // First click — start confirm timer
        setConfirmingDelete(name);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = setTimeout(() => {
          setConfirmingDelete(null);
        }, 3000);
      }
    },
    [confirmingDelete, refresh]
  );

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load connectors
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4">{error.message}</p>
        <button onClick={refresh} className="btn-primary flex items-center gap-2">
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-end justify-between animate-fade-in-up">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Connectors</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Manage shared MCP tool servers available to all agents.
          </p>
        </div>
        <button
          onClick={openAddForm}
          className="btn-primary flex items-center gap-2 text-[13px]"
        >
          <Plus size={14} />
          Add Server
        </button>
      </div>

      {/* Inline add/edit form */}
      {showForm && (
        <div
          className="card animate-fade-in-up"
          style={{ animationDelay: '40ms' }}
        >
          <div className="card-header flex items-center justify-between">
            <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
              {editingServer ? 'Edit Server' : 'Add Server'}
            </h3>
            <button
              onClick={resetForm}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <div className="card-body space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1.5 block">
                  Name
                </label>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="e.g. slack-tools"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  disabled={!!editingServer}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1.5 block">
                  URL
                </label>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="https://mcp.example.com/sse"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                />
              </div>
            </div>

            {/* Headers */}
            <div>
              <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1.5 block">
                Headers
              </label>
              {formHeaders.length > 0 && (
                <div className="space-y-2 mb-2">
                  {formHeaders.map((header, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <input
                        type="text"
                        className="input flex-1"
                        placeholder="Header name"
                        value={header.key}
                        onChange={(e) => updateHeader(index, 'key', e.target.value)}
                      />
                      <input
                        type="text"
                        className="input flex-1"
                        placeholder="Value"
                        value={header.value}
                        onChange={(e) => updateHeader(index, 'value', e.target.value)}
                      />
                      <button
                        onClick={() => removeHeader(index)}
                        className="text-muted-foreground hover:text-rose transition-colors shrink-0 p-1"
                      >
                        <XCircle size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={addHeaderRow}
                className="text-[12px] text-amber hover:text-amber/80 font-medium transition-colors"
              >
                + Add Header
              </button>
              <p className="text-[11px] text-muted-foreground mt-1">
                Use <code className="text-amber/70 bg-amber/5 px-1 rounded text-[10px]">{'{API_KEY}'}</code> syntax for credential placeholders in header values.
              </p>
            </div>

            {/* Form error */}
            {formError && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-rose/5 border border-rose/15">
                <AlertTriangle size={14} className="text-rose shrink-0" />
                <p className="text-[13px] text-rose">{formError}</p>
              </div>
            )}

            {/* Test result */}
            {formTestResult && (
              <div
                className={`flex items-start gap-2 p-3 rounded-lg border ${
                  formTestResult.ok
                    ? 'bg-emerald/5 border-emerald/15'
                    : 'bg-rose/5 border-rose/15'
                }`}
              >
                {formTestResult.ok ? (
                  <>
                    <CheckCircle size={14} className="text-emerald shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[13px] text-emerald font-medium">Connection successful</p>
                      {formTestResult.tools && formTestResult.tools.length > 0 && (
                        <p className="text-[11px] text-emerald/70 mt-0.5">
                          {formTestResult.tools.length} tool{formTestResult.tools.length !== 1 ? 's' : ''} discovered
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <XCircle size={14} className="text-rose shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[13px] text-rose font-medium">Connection failed</p>
                      {formTestResult.error && (
                        <p className="text-[11px] text-rose/70 mt-0.5">
                          {formTestResult.error}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Form actions */}
            <div className="flex items-center gap-3 pt-2 border-t border-border/30">
              <button onClick={resetForm} className="btn-secondary text-[13px]">
                Cancel
              </button>
              {formTestResult && !formTestResult.ok ? (
                <button
                  onClick={handleSaveAnyway}
                  className="btn-primary flex items-center gap-2 text-[13px]"
                >
                  Save Anyway
                </button>
              ) : (
                <button
                  onClick={handleTestAndSave}
                  disabled={testingForm || saving}
                  className="btn-primary flex items-center gap-2 text-[13px]"
                >
                  {testingForm ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Testing...
                    </>
                  ) : (
                    <>
                      <Zap size={14} />
                      Test &amp; Save
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Server list */}
      <div className="card animate-fade-in-up" style={{ animationDelay: '80ms' }}>
        <div className="card-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-amber" strokeWidth={1.8} />
            <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
              MCP Servers
            </h3>
          </div>
          {servers && (
            <span className="text-[11px] font-medium text-muted-foreground">
              {servers.length} total
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          {loading && !servers ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-12 w-full" />
              ))}
            </div>
          ) : !servers || servers.length === 0 ? (
            /* Empty state */
            <div className="text-center py-12">
              <Globe size={32} className="text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-[13px] text-muted-foreground mb-4">
                No MCP servers configured
              </p>
              <button
                onClick={openAddForm}
                className="btn-primary inline-flex items-center gap-2 text-[13px]"
              >
                <Plus size={14} />
                Add Server
              </button>
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/50 text-left">
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Name
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    URL
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {servers.map((server) => {
                  const status = serverStatuses[server.name] ?? 'untested';
                  const isTesting = testingServer === server.name;

                  return (
                    <tr
                      key={server.id}
                      className="hover:bg-foreground/[0.02] transition-colors"
                    >
                      <td className="px-6 py-3">
                        <span className="font-medium text-foreground">
                          {server.name}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        <span className="font-mono text-[12px] text-muted-foreground truncate block max-w-[300px]">
                          {server.url}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        {isTesting ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Loader2 size={12} className="animate-spin text-amber" />
                            <span className="text-[11px] text-muted-foreground">Testing...</span>
                          </span>
                        ) : status === 'connected' ? (
                          <span className="badge-green">Connected</span>
                        ) : status === 'failed' ? (
                          <span className="badge-red">Failed</span>
                        ) : (
                          <span className="badge-zinc">Untested</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleTestServer(server.name)}
                            disabled={isTesting}
                            className="btn-secondary text-[12px] px-2.5 py-1 flex items-center gap-1.5"
                          >
                            <Zap size={12} />
                            Test
                          </button>
                          <button
                            onClick={() => openEditForm(server)}
                            className="btn-secondary text-[12px] px-2.5 py-1 flex items-center gap-1.5"
                          >
                            <Pencil size={12} />
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteClick(server.name)}
                            className="btn-danger text-[12px] px-2.5 py-1 flex items-center gap-1.5"
                          >
                            <Trash2 size={12} />
                            {confirmingDelete === server.name ? 'Confirm?' : 'Remove'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
