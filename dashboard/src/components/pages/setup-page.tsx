import { useState, type FormEvent } from 'react';
import {
  Shield,
  ChevronRight,
  Key,
  Terminal,
  CheckCircle,
  AlertTriangle,
  Eye,
  Activity,
  Zap,
} from 'lucide-react';
import { apiFetch, setToken } from '../../lib/api';
import type { SetupResponse } from '../../lib/types';

type Step = 'welcome' | 'profile' | 'agent-type' | 'api-key' | 'review' | 'done';

const STEPS: Step[] = ['welcome', 'profile', 'agent-type', 'api-key', 'review', 'done'];

interface SetupPageProps {
  onComplete: () => void;
}

const PROFILES = [
  {
    id: 'paranoid',
    label: 'Paranoid',
    icon: Shield,
    color: 'border-red-500/30 hover:border-red-500/50',
    selectedColor: 'border-red-500 bg-red-500/5',
    iconColor: 'text-red-400',
    description:
      'Maximum security. No network access for agents. All content is taint-tagged. Every operation is audited and scrutinized. Recommended for production.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    icon: Eye,
    color: 'border-amber-500/30 hover:border-amber-500/50',
    selectedColor: 'border-amber-500 bg-amber-500/5',
    iconColor: 'text-amber-400',
    description:
      'Reasonable defaults. Network restricted to allowlisted domains. Content tainting enabled for external sources. Good for most use cases.',
  },
  {
    id: 'yolo',
    label: 'YOLO',
    icon: Zap,
    color: 'border-green-500/30 hover:border-green-500/50',
    selectedColor: 'border-green-500 bg-green-500/5',
    iconColor: 'text-green-400',
    description:
      'Minimal restrictions. Agents can access the network freely. Use only in trusted, isolated development environments. Not recommended for production.',
  },
];

const AGENT_TYPES = [
  {
    id: 'pi-session',
    label: 'PI Session',
    icon: Terminal,
    description: 'General-purpose AI agent with tool access and sandboxing.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: Activity,
    description:
      'Code-focused agent powered by Claude with file system and terminal tools.',
  },
];

function StepIndicator({ current, steps }: { current: Step; steps: Step[] }) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((step, i) => (
        <div
          key={step}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i <= currentIndex
              ? 'bg-amber-500 w-8'
              : 'bg-zinc-700 w-4'
          }`}
        />
      ))}
    </div>
  );
}

export default function SetupPage({ onComplete }: SetupPageProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [profile, setProfile] = useState('balanced');
  const [agentType, setAgentType] = useState('pi-session');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  const goNext = () => {
    const nextIndex = stepIndex + 1;
    if (nextIndex < STEPS.length) {
      setStep(STEPS[nextIndex]);
      setError('');
    }
  };

  const goBack = () => {
    const prevIndex = stepIndex - 1;
    if (prevIndex >= 0) {
      setStep(STEPS[prevIndex]);
      setError('');
    }
  };

  const handleConfigure = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await apiFetch<SetupResponse>('/setup/configure', {
        method: 'POST',
        body: JSON.stringify({
          profile,
          agentType,
          apiKey: apiKey.trim(),
        }),
      });

      setToken(result.token);
      setStep('done');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Configuration failed'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 mb-4">
            <span className="text-3xl" role="img" aria-label="crab">
              🦀
            </span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">AX Setup</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Configure your AX instance
          </p>
          <div className="mt-4 flex justify-center">
            <StepIndicator current={step} steps={STEPS} />
          </div>
        </div>

        {/* Step content */}
        <div className="card">
          <div className="p-6">
            {/* Welcome */}
            {step === 'welcome' && (
              <div className="text-center space-y-4">
                <Shield size={40} className="text-amber-500 mx-auto" />
                <h2 className="text-lg font-semibold text-zinc-100">
                  Welcome to AX
                </h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  AX is a security-focused AI agent platform. We are going to walk you through a few configuration steps to get things running. We will set up your security profile, choose an agent type, and configure API access.
                </p>
                <p className="text-xs text-zinc-600">
                  This should take about a minute.
                </p>
              </div>
            )}

            {/* Security Profile */}
            {step === 'profile' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-zinc-100">
                    Security Profile
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    How paranoid should we be?
                  </p>
                </div>
                <div className="space-y-3">
                  {PROFILES.map((p) => {
                    const Icon = p.icon;
                    const isSelected = profile === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setProfile(p.id)}
                        className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-200 ${
                          isSelected ? p.selectedColor : `${p.color} bg-transparent`
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-1.5 rounded bg-zinc-800 shrink-0 mt-0.5">
                            <Icon size={18} className={p.iconColor} />
                          </div>
                          <div>
                            <p className="font-medium text-zinc-200">
                              {p.label}
                            </p>
                            <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                              {p.description}
                            </p>
                          </div>
                          {isSelected && (
                            <CheckCircle
                              size={18}
                              className="text-amber-500 shrink-0 mt-0.5 ml-auto"
                            />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Agent Type */}
            {step === 'agent-type' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-zinc-100">
                    Agent Type
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Choose your default agent runner
                  </p>
                </div>
                <div className="space-y-3">
                  {AGENT_TYPES.map((at) => {
                    const Icon = at.icon;
                    const isSelected = agentType === at.id;
                    return (
                      <button
                        key={at.id}
                        type="button"
                        onClick={() => setAgentType(at.id)}
                        className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-200 ${
                          isSelected
                            ? 'border-amber-500 bg-amber-500/5'
                            : 'border-zinc-700 hover:border-zinc-600 bg-transparent'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-1.5 rounded bg-zinc-800 shrink-0 mt-0.5">
                            <Icon size={18} className="text-amber-500" />
                          </div>
                          <div>
                            <p className="font-medium text-zinc-200">
                              {at.label}
                            </p>
                            <p className="text-xs text-zinc-500 mt-1">
                              {at.description}
                            </p>
                          </div>
                          {isSelected && (
                            <CheckCircle
                              size={18}
                              className="text-amber-500 shrink-0 mt-0.5 ml-auto"
                            />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* API Key */}
            {step === 'api-key' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-zinc-100">
                    API Key
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Enter your LLM provider API key
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="api-key"
                    className="block text-sm font-medium text-zinc-300 mb-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <Key size={14} />
                      API Key
                    </div>
                  </label>
                  <input
                    id="api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="input w-full"
                    autoFocus
                  />
                  <p className="text-xs text-zinc-600 mt-2">
                    This key is stored securely on the server and never exposed to
                    agent sandboxes.
                  </p>
                </div>
              </div>
            )}

            {/* Review */}
            {step === 'review' && (
              <form onSubmit={handleConfigure} className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-zinc-100">
                    Review Configuration
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Confirm your settings before we start
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 rounded bg-zinc-800/50">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <Shield size={14} />
                      Security Profile
                    </div>
                    <span className="text-sm font-medium text-zinc-200 capitalize">
                      {profile}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded bg-zinc-800/50">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <Terminal size={14} />
                      Agent Type
                    </div>
                    <span className="text-sm font-medium text-zinc-200">
                      {AGENT_TYPES.find((at) => at.id === agentType)?.label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded bg-zinc-800/50">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <Key size={14} />
                      API Key
                    </div>
                    <span className="text-sm font-medium text-zinc-200 font-mono">
                      {apiKey ? `${apiKey.slice(0, 7)}${'*'.repeat(8)}` : 'Not set'}
                    </span>
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
                    <AlertTriangle
                      size={16}
                      className="text-red-400 mt-0.5 shrink-0"
                    />
                    <p className="text-sm text-red-400">{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                      Configuring...
                    </>
                  ) : (
                    <>
                      <CheckCircle size={16} />
                      Configure AX
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Done */}
            {step === 'done' && (
              <div className="text-center space-y-4">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 border border-green-500/20">
                  <CheckCircle size={32} className="text-green-400" />
                </div>
                <h2 className="text-lg font-semibold text-zinc-100">
                  All Set!
                </h2>
                <p className="text-sm text-zinc-400">
                  AX is configured and ready to go. Your admin token has been
                  generated and saved.
                </p>
                <button
                  onClick={onComplete}
                  className="btn-primary flex items-center gap-2 mx-auto"
                >
                  Open Dashboard
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>

          {/* Navigation footer */}
          {step !== 'done' && step !== 'review' && (
            <div className="px-6 pb-6 flex items-center justify-between">
              {step === 'welcome' ? (
                <div />
              ) : (
                <button
                  onClick={goBack}
                  className="btn-secondary text-sm"
                >
                  Back
                </button>
              )}
              <button
                onClick={goNext}
                disabled={step === 'api-key' && !apiKey.trim()}
                className="btn-primary flex items-center gap-1.5 text-sm"
              >
                {step === 'welcome' ? 'Get Started' : 'Continue'}
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
