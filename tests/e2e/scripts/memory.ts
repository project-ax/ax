import type { ScriptedTurn } from './types.js';

export const MEMORY_TURNS: ScriptedTurn[] = [
  // Turn 10: Memory write — user asks agent to remember something
  {
    match: /remember.*prefer|remember.*dark mode|remember.*setting/i,
    response: {
      content: 'Got it! I\'ll remember that preference for you.',
      tool_calls: [{
        id: 'tc_memory_write_1',
        type: 'function',
        function: {
          name: 'memory',
          arguments: JSON.stringify({
            type: 'write',
            scope: 'user-prefs',
            content: 'User prefers dark mode for all interfaces.',
            tags: ['preference', 'ui'],
          }),
        },
      }],
    },
  },
  // Turn 11: Memory write duplicate — tests dedup/reinforcement
  {
    match: /also.*remember|another.*preference|remember.*too/i,
    response: {
      content: 'Noted — reinforcing that preference.',
      tool_calls: [{
        id: 'tc_memory_write_2',
        type: 'function',
        function: {
          name: 'memory',
          arguments: JSON.stringify({
            type: 'write',
            scope: 'user-prefs',
            content: 'User prefers dark mode for all interfaces.',
            tags: ['preference', 'ui'],
          }),
        },
      }],
    },
  },
  // Turn 12: Memory query — cross-session recall
  {
    match: /what.*prefer|my.*settings|recall.*memory/i,
    response: {
      content: 'Let me check what I remember about your preferences.',
      tool_calls: [{
        id: 'tc_memory_query_1',
        type: 'function',
        function: {
          name: 'memory',
          arguments: JSON.stringify({
            type: 'query',
            scope: 'user-prefs',
            query: 'user preferences settings',
            limit: 10,
          }),
        },
      }],
    },
  },
  // Turn 13: Memory list — list all items in scope
  {
    match: /list.*memories|show.*remembered|all.*memories/i,
    response: {
      content: 'Here are all the memories I have stored.',
      tool_calls: [{
        id: 'tc_memory_list_1',
        type: 'function',
        function: {
          name: 'memory',
          arguments: JSON.stringify({
            type: 'list',
            scope: 'user-prefs',
            limit: 20,
          }),
        },
      }],
    },
  },
];
