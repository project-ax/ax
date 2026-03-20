import type { ScriptedTurn } from './types.js';

export const BOOTSTRAP_TURNS: ScriptedTurn[] = [
  // Turn 1: User introduces self → agent calls identity tool
  {
    match: /my name is/i,
    response: {
      content: 'Nice to meet you! Let me save your info.',
      tool_calls: [{
        id: 'tc_user_1',
        type: 'function',
        function: {
          name: 'identity',
          arguments: JSON.stringify({
            type: 'user_write',
            userId: 'testuser',
            content: '# TestUser\n\n**Name:** TestUser\n**Notes:** Participant in acceptance testing.',
            reason: 'Recording user name from introduction',
            origin: 'user_request',
          }),
        },
      }],
    },
  },
  // Turn 2: User sets agent identity → agent writes IDENTITY.md + SOUL.md
  {
    match: /your name is|witty and funny|acceptance testing/i,
    response: {
      content: 'Done! I am Reginald, your witty acceptance testing companion.',
      tool_calls: [
        {
          id: 'tc_identity_1',
          type: 'function',
          function: {
            name: 'identity',
            arguments: JSON.stringify({
              type: 'write',
              file: 'IDENTITY.md',
              content: '# Reginald\n\n**Name:** Reginald\n**Creature:** AI\n**Vibe:** Witty and funny\n**Emoji:** \u{1F9EA}\n\n## Purpose\nAcceptance testing companion.',
              reason: 'Setting identity per user request',
              origin: 'user_request',
            }),
          },
        },
        {
          id: 'tc_soul_1',
          type: 'function',
          function: {
            name: 'identity',
            arguments: JSON.stringify({
              type: 'write',
              file: 'SOUL.md',
              content: '# Soul of Reginald\n\n## Core Philosophy\nI exist to make acceptance testing bearable through wit and reliability.\n\n## Voice\nWitty, funny, occasionally sarcastic but always helpful.',
              reason: 'Establishing personality',
              origin: 'user_request',
            }),
          },
        },
      ],
    },
  },
];
