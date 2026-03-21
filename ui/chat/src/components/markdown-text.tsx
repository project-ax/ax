import type { FC } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    className="prose prose-invert max-w-none prose-pre:bg-muted prose-pre:rounded-lg prose-code:font-mono prose-code:text-sm"
  />
);
