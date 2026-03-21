import { useState, useEffect, useRef, type FC } from 'react';
import { KeyRound, X, Eye, EyeOff } from 'lucide-react';
import type { CredentialRequiredEvent } from '../lib/ax-chat-transport';

interface CredentialModalProps {
  request: CredentialRequiredEvent;
  onSubmit: () => void;
  onCancel: () => void;
}

export const CredentialModal: FC<CredentialModalProps> = ({
  request,
  onSubmit,
  onCancel,
}) => {
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || submitting) return;

    setSubmitting(true);
    try {
      await fetch('/v1/credentials/provide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envName: request.envName,
          value: value.trim(),
          sessionId: request.sessionId,
        }),
      });
      onSubmit();
    } catch {
      // If the request fails, still dismiss — the user can retry
      onSubmit();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-border/40 bg-card/95 shadow-2xl backdrop-blur-md animate-fade-in-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/30">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber/10">
              <KeyRound className="h-4 w-4 text-amber" strokeWidth={1.8} />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
                Credential Required
              </h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                The agent needs this to proceed
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03] transition-colors duration-150"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-6 py-5">
          <label className="block text-[10px] font-medium uppercase tracking-widest text-muted-foreground mb-2">
            {request.envName}
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              type={showValue ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`Enter value for ${request.envName}`}
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2.5 pr-10 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-amber/50 focus:ring-[3px] focus:ring-amber/10 focus:outline-none transition-all duration-150 font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowValue(!showValue)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground transition-colors duration-150"
            >
              {showValue
                ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.8} />
                : <Eye className="h-3.5 w-3.5" strokeWidth={1.8} />
              }
            </button>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-4 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03] border border-border/50 transition-all duration-150"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value.trim() || submitting}
              className="rounded-lg bg-amber px-4 py-2 text-[13px] font-medium text-primary-foreground hover:bg-amber/90 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Saving...' : 'Provide'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
