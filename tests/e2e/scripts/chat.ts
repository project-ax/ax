import type { ScriptedTurn } from './types.js';

export const CHAT_TURNS: ScriptedTurn[] = [
  // Turn 3: Persistence check — agent should respond with identity
  {
    match: /who are you|what is your name/i,
    response: {
      content: 'I am Reginald! Your witty acceptance testing companion. \u{1F9EA}',
    },
  },
  // Turn 4: web_fetch tool call through proxy
  {
    match: /fetch.*url|web.*fetch|get.*page/i,
    response: {
      content: 'Let me fetch that page for you.',
      tool_calls: [{
        id: 'tc_webfetch_1',
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'http://mock-target.test/web-fetch-target' }),
        },
      }],
    },
  },
  // Turn 5: File creation via bash
  {
    match: /create.*file|write.*file|make.*file/i,
    response: {
      content: 'Creating the file now.',
      tool_calls: [{
        id: 'tc_bash_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: 'echo "acceptance-test-content-12345" > /workspace/test-file.txt' }),
        },
      }],
    },
  },
  // Turn 6: File persistence check
  {
    match: /read.*file|check.*file|what.*file/i,
    response: {
      content: 'The file contains: acceptance-test-content-12345',
      tool_calls: [{
        id: 'tc_bash_2',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: 'cat /workspace/test-file.txt' }),
        },
      }],
    },
  },
  // Turn 7: Bash + proxy (curl)
  {
    match: /curl|http.*request|proxy.*test/i,
    response: {
      content: 'Running curl through the proxy.',
      tool_calls: [{
        id: 'tc_bash_3',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: 'curl -s http://mock-target.test/web-fetch-target' }),
        },
      }],
    },
  },
];
