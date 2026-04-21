export type { ScriptedTurn } from './types.js';
export { BOOTSTRAP_TURNS } from './bootstrap.js';
export { CHAT_TURNS } from './chat.js';
export { SKILL_TURNS } from './skills.js';
export { MEMORY_TURNS } from './memory.js';
export { SCHEDULER_TURNS } from './scheduler.js';
export { TOOL_DISPATCH_TURNS } from './tool-dispatch.js';
export { LINEAR_FLOW_TURNS } from './linear-flow.js';

import { BOOTSTRAP_TURNS } from './bootstrap.js';
import { CHAT_TURNS } from './chat.js';
import { SKILL_TURNS } from './skills.js';
import { MEMORY_TURNS } from './memory.js';
import { SCHEDULER_TURNS } from './scheduler.js';
import { TOOL_DISPATCH_TURNS } from './tool-dispatch.js';
import { LINEAR_FLOW_TURNS } from './linear-flow.js';

/** All turns in order for the full regression sequence. */
export const ALL_TURNS = [
  ...BOOTSTRAP_TURNS,
  ...CHAT_TURNS,
  ...SKILL_TURNS,
  ...MEMORY_TURNS,
  ...SCHEDULER_TURNS,
  ...TOOL_DISPATCH_TURNS,
  ...LINEAR_FLOW_TURNS,
];
