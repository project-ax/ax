import type { ThreadHistoryAdapter } from '@assistant-ui/react';

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at?: number;
}

/**
 * AX-backed ThreadHistoryAdapter.
 * Loads conversation history from /v1/chat/sessions/:id/history.
 * Implements withFormat to work with useExternalHistory's format-aware loading.
 * Append is a no-op since AX server persists turns during chat completions.
 */
export const createAxHistoryAdapter = (
  getRemoteId: () => string | undefined,
): ThreadHistoryAdapter => ({
  async load() {
    // Direct load (ThreadMessage format) — not used by useExternalHistory
    // but required by the interface.
    return { messages: [] };
  },

  async append() {
    // No-op: AX server persists turns during processCompletion.
  },

  withFormat(formatAdapter) {
    return {
      async load() {
        const remoteId = getRemoteId();
        if (!remoteId) return { messages: [] };

        const response = await fetch(`/v1/chat/sessions/${encodeURIComponent(remoteId)}/history`);
        if (!response.ok) {
          if (response.status === 404) return { messages: [] };
          throw new Error('Failed to fetch history');
        }

        const { messages: serverMessages } = await response.json();

        // Convert server messages to UIMessage format via the formatAdapter.decode()
        const items = (serverMessages as HistoryMessage[]).map((m, index) => {
          const id = `${remoteId}-${index}`;
          const parentId = index > 0 ? `${remoteId}-${index - 1}` : null;

          // Decode from storage entry format
          return formatAdapter.decode({
            id,
            parent_id: parentId,
            format: formatAdapter.format,
            content: {
              role: m.role,
              parts: [{ type: 'text' as const, text: m.content }],
              createdAt: m.created_at ? new Date(m.created_at * 1000) : new Date(),
            } as any,
          });
        });

        return { messages: items };
      },

      async append() {
        // No-op: AX server persists turns during processCompletion.
      },
    };
  },
});
