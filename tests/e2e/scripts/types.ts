export interface ScriptedTurn {
  /** Pattern to match in the latest user message */
  match: RegExp | string;
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
