import { useMemo, useRef } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  RuntimeAdapterProvider,
  useAuiState,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';
import { AxChatTransport, type CredentialRequiredEvent } from './ax-chat-transport';

/**
 * Thread-specific runtime using AI SDK.
 */
const useChatThreadRuntime = (transport: AxChatTransport): AssistantRuntime => {
  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const chat = useChat({ id, transport });
  return useAISDKRuntime(chat);
};

/**
 * Provider that injects AX history adapter into the runtime context.
 */
const AxHistoryProvider = ({ children }: { children?: React.ReactNode }) => {
  const aui = useAui();

  const history = useMemo<ThreadHistoryAdapter>(
    () =>
      createAxHistoryAdapter(
        () => aui.threadListItem().getState().remoteId,
      ),
    [aui],
  );

  const adapters = useMemo(() => ({ history }), [history]);

  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
};

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 * Returns the runtime and a credential request handler for the modal.
 */
export const useAxChatRuntime = (
  onCredentialRequired?: (event: CredentialRequiredEvent) => void,
): AssistantRuntime => {
  const callbackRef = useRef(onCredentialRequired);
  callbackRef.current = onCredentialRequired;

  const transport = useMemo(
    () =>
      new AxChatTransport({
        api: '/v1/chat/completions',
        onCredentialRequired: (event) => callbackRef.current?.(event),
      }),
    [],
  );

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport),
    adapter: {
      ...axThreadListAdapter,
      unstable_Provider: AxHistoryProvider,
    },
  });
};
