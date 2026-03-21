import type { FC } from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { PlusIcon } from 'lucide-react';

export const ThreadList: FC = () => (
  <ThreadListPrimitive.Root className="flex flex-col items-stretch gap-1.5">
    <ThreadListNew />
    <ThreadListItems />
  </ThreadListPrimitive.Root>
);

const ThreadListNew: FC = () => (
  <div className="flex justify-center px-2 py-4">
    <ThreadListPrimitive.New asChild>
      <button className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
        <PlusIcon className="size-4" />
        New Chat
      </button>
    </ThreadListPrimitive.New>
  </div>
);

const ThreadListItems: FC = () => {
  const isLoading = useAuiState(({ threads }) => threads.isLoading);

  if (isLoading) {
    return (
      <>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md px-3 py-2">
            <div className="h-5 flex-grow animate-pulse rounded bg-muted" />
          </div>
        ))}
      </>
    );
  }

  return <ThreadListPrimitive.Items components={{ ThreadListItem }} />;
};

const ThreadListItem: FC = () => (
  <ThreadListItemPrimitive.Root className="flex items-center gap-2 rounded-lg transition-all hover:bg-muted focus-visible:bg-muted data-active:bg-muted">
    <ThreadListItemPrimitive.Trigger className="truncate grow px-3 py-2 text-start">
      <span className="text-sm">
        <ThreadListItemPrimitive.Title fallback="New Chat" />
      </span>
    </ThreadListItemPrimitive.Trigger>
  </ThreadListItemPrimitive.Root>
);
