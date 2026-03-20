import type { ScriptedTurn } from './types.js';

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
