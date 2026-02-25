// src/providers/llm/types.ts — LLM provider types
import type { ContentBlock, Message } from '../../types.js';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Callback to resolve an image file reference to its binary data. */
export type ResolveImageFile = (fileId: string) => Promise<{ data: Buffer; mimeType: string } | null>;

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  stream?: boolean;
  /** Resolves image fileId references to binary data for LLM vision. */
  resolveImageFile?: ResolveImageFile;
}

export interface ChatChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  name: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  models(): Promise<string[]>;
}
