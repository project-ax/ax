# Provider Lessons: Memory

### Check dependency chain before implementing plan tasks — missing prereqs block you
**Date:** 2026-03-02
**Context:** Implementing Task 8 (MemoryFS Provider) which depends on Task 2 (ItemsStore). The ItemsStore had not been implemented yet, though the plan listed it as a prerequisite.
**Lesson:** Before starting a plan task, verify that all dependency tasks listed in the plan's build order are actually implemented. The plan specifies "Task 8 depends on Tasks 2-7" but doesn't enforce it. Check for the actual source files, not just the plan text. If a prerequisite is missing, implement it inline -- the plan already has the full spec.
**Tags:** memoryfs, dependencies, plan-execution, items-store

### Salience formula produces 0 at zero reinforcement — test ratios need nonzero counts
**Date:** 2026-03-02
**Context:** Implementing salience scoring. Tests compared ratios of scores with reinforcementCount: 0, which produces 0/0 = NaN because log(0+1) = log(1) = 0.
**Lesson:** When testing ratio properties (half-life decay, null fallback) of a multiplicative formula, ensure all other multiplicative factors are nonzero. For salience scoring, use reinforcementCount >= 1 in ratio tests since log(1) = 0 zeroes out the entire product. Add a separate edge-case test to verify zero reinforcement produces score 0.
**Tags:** salience, math, testing, edge-cases, memoryfs

### pi-agent-core only supports text — image blocks must bypass it
**Date:** 2026-02-26
**Context:** Debugging why Slack image attachments weren't visible to the LLM despite being downloaded and stored correctly.
**Lesson:** pi-agent-core (`@mariozechner/pi-agent-core`) only handles text user messages. When the user message includes non-text content blocks (images), they must be extracted before entering pi-agent-core and injected into the IPC/LLM call messages separately. The injection point is in `createIPCStreamFn()` after `convertPiMessages()` runs — find the last user message with string content (the prompt, not tool results) and convert it to structured content with text + image blocks.
**Tags:** pi-agent-core, images, ipc-transport, slack, vision
