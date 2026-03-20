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

export const SCHEDULER_TURNS: ScriptedTurn[] = [
  // Turn 14: Add cron job
  {
    match: /schedule.*daily|daily.*reminder|set.*cron|recurring.*task/i,
    response: {
      content: 'I\'ll set up a daily reminder for you.',
      tool_calls: [{
        id: 'tc_scheduler_add_1',
        type: 'function',
        function: {
          name: 'scheduler',
          arguments: JSON.stringify({
            type: 'add_cron',
            schedule: '0 9 * * *',
            prompt: 'Remind the user to check their test results.',
          }),
        },
      }],
    },
  },
  // Turn 15: Schedule one-shot job
  {
    match: /schedule.*once|one.*time.*task|run.*at|remind.*me.*at/i,
    response: {
      content: 'I\'ll schedule that one-time task.',
      tool_calls: [{
        id: 'tc_scheduler_runat_1',
        type: 'function',
        function: {
          name: 'scheduler',
          arguments: JSON.stringify({
            type: 'run_at',
            datetime: '2026-12-31T23:59:00',
            prompt: 'Wish the user a happy new year.',
          }),
        },
      }],
    },
  },
  // Turn 16: List scheduled jobs
  {
    match: /list.*schedule|show.*jobs|my.*scheduled|what.*scheduled/i,
    response: {
      content: 'Let me check your scheduled tasks.',
      tool_calls: [{
        id: 'tc_scheduler_list_1',
        type: 'function',
        function: {
          name: 'scheduler',
          arguments: JSON.stringify({
            type: 'list',
          }),
        },
      }],
    },
  },
];

/** All turns in order for the full regression sequence. */
export const ALL_TURNS: ScriptedTurn[] = [
  ...BOOTSTRAP_TURNS,
  ...CHAT_TURNS,
  ...SKILL_TURNS,
  ...MEMORY_TURNS,
  ...SCHEDULER_TURNS,
];
