import type { ScriptedTurn } from './types.js';

export const SKILL_TURNS: ScriptedTurn[] = [
  // Turn 8: Skill install triggers credential requirement
  {
    match: /install.*linear|linear.*skill|add.*linear/i,
    response: {
      content: 'I\'ll install the Linear skill for you. It requires a LINEAR_API_KEY.',
      tool_calls: [{
        id: 'tc_skill_1',
        type: 'function',
        function: {
          name: 'skills',
          arguments: JSON.stringify({ action: 'install', slug: 'ManuelHettich/linear' }),
        },
      }],
    },
  },
  // Turn 9: Linear tool call after credential provided
  {
    match: /linear.*issues|list.*issues|show.*issues/i,
    response: {
      content: 'Let me fetch your Linear issues.',
      tool_calls: [{
        id: 'tc_linear_1',
        type: 'function',
        function: {
          name: 'linear',
          arguments: JSON.stringify({ query: '{ issues { nodes { id title } } }' }),
        },
      }],
    },
  },
];
