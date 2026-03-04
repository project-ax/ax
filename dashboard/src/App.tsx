import { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  Activity,
  Users,
  FileText,
  Settings,
  LogOut,
} from 'lucide-react';
import { getToken, clearToken, apiFetch } from './lib/api';
import type { SetupStatus } from './lib/types';
import LoginPage from './components/pages/login-page';
import SetupPage from './components/pages/setup-page';
import OverviewPage from './components/pages/overview-page';
import AgentsPage from './components/pages/agents-page';
import SecurityPage from './components/pages/security-page';
import LogsPage from './components/pages/logs-page';
import SettingsPage from './components/pages/settings-page';

type Page = 'overview' | 'agents' | 'security' | 'logs' | 'settings';

const NAV_ITEMS: { id: Page; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [activePage, setActivePage] = useState<Page>('overview');
  const [checkingSetup, setCheckingSetup] = useState(true);

  // Check if initial setup is needed
  useEffect(() => {
    let cancelled = false;

    async function checkSetup() {
      try {
        const result = await apiFetch<SetupStatus>('/setup/status');
        if (!cancelled) {
          setNeedsSetup(!result.configured);
          setCheckingSetup(false);
        }
      } catch {
        // If we can't reach the endpoint, assume configured
        if (!cancelled) {
          setNeedsSetup(false);
          setCheckingSetup(false);
        }
      }
    }

    checkSetup();
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  // Listen for auth-required events (dispatched by apiFetch on 401)
  const handleAuthRequired = useCallback(() => {
    clearToken();
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    window.addEventListener('ax:auth-required', handleAuthRequired);
    return () => {
      window.removeEventListener('ax:auth-required', handleAuthRequired);
    };
  }, [handleAuthRequired]);

  const handleLogin = useCallback(() => {
    setAuthenticated(true);
  }, []);

  const handleSetupComplete = useCallback(() => {
    setNeedsSetup(false);
    setAuthenticated(true);
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setAuthenticated(false);
  }, []);

  // Show setup wizard if not configured
  if (checkingSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3 text-zinc-400">
          <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          <span>Connecting to AX...</span>
        </div>
      </div>
    );
  }

  if (needsSetup) {
    return <SetupPage onComplete={handleSetupComplete} />;
  }

  // Show login if not authenticated
  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Main dashboard layout
  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        {/* Logo */}
        <div className="px-4 py-5 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-2xl" role="img" aria-label="crab">
              🦀
            </span>
            <div>
              <h1 className="text-lg font-bold text-zinc-100 tracking-tight">
                AX
              </h1>
              <p className="text-xs text-zinc-500">Admin Dashboard</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 space-y-1">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActivePage(id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-150
                ${
                  activePage === id
                    ? 'bg-zinc-800 text-amber-500'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
                }`}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>

        {/* Logout */}
        <div className="px-2 py-3 border-t border-zinc-800">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50 transition-colors duration-150"
          >
            <LogOut size={18} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6 max-w-7xl mx-auto">
          {activePage === 'overview' && <OverviewPage />}
          {activePage === 'agents' && <AgentsPage />}
          {activePage === 'security' && <SecurityPage />}
          {activePage === 'logs' && <LogsPage />}
          {activePage === 'settings' && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
