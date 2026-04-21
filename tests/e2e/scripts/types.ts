export interface ScriptedTurn {
  /** Pattern matched against the latest user message. */
  match: RegExp | string;
  /**
   * Optional pattern matched against the latest tool-result message's content.
   * Used for multi-turn tool-chaining flows where the mock needs to emit a
   * different scripted response depending on which tool just returned. When
   * set, and the last message is a tool result, the mock first tries to match
   * tool-result content against turns with `matchToolResult`; only if none
   * match does it fall back to the default tool-result summary behavior
   * (content-only "Done. Tool returned: ...").
   */
  matchToolResult?: RegExp | string;
  /** Response to return */
  response: {
    content?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finishReason?: string;
}
