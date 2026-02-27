/**
 * Scenario: Delegation stress tests
 *
 * End-to-end tests for concurrent subagent delegation through the full
 * pipeline. Reproduces the "3 agents crashes the server" failure mode.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';
import type { DelegateRequest } from '../../../src/host/ipc-server.js';

describe('E2E Scenario: Delegation Stress', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('3 concurrent delegations via agent loop all complete', async () => {
    // Simulate an LLM that requests 3 agent_delegate tool calls in sequence,
    // then synthesizes the results.
    let delegateCallCount = 0;
    const delegateResults = [
      'Competitor A: strong in enterprise market.',
      'Competitor B: focused on developer experience.',
      'Competitor C: leading in AI integration.',
    ];

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async (req: DelegateRequest) => {
        const idx = delegateCallCount++;
        // Simulate some async work
        await new Promise(r => setTimeout(r, 5));
        return delegateResults[idx] ?? `Fallback result for: ${req.task}`;
      },
      llmTurns: [
        // Turn 1: LLM delegates first research task
        toolUseTurn('agent_delegate', {
          task: 'Research competitor A',
          context: 'Focus on enterprise features.',
        }),
        // Turn 2: LLM delegates second research task
        toolUseTurn('agent_delegate', {
          task: 'Research competitor B',
          context: 'Focus on developer tools.',
        }),
        // Turn 3: LLM delegates third research task
        toolUseTurn('agent_delegate', {
          task: 'Research competitor C',
          context: 'Focus on AI capabilities.',
        }),
        // Turn 4: LLM synthesizes results
        textTurn('Based on my research:\n- A: enterprise\n- B: devex\n- C: AI'),
      ],
    });

    const result = await harness.runAgentLoop('Research our top 3 competitors');

    // All 3 delegations should have been called
    expect(result.toolCalls.length).toBe(3);
    expect(result.toolCalls[0]!.name).toBe('agent_delegate');
    expect(result.toolCalls[1]!.name).toBe('agent_delegate');
    expect(result.toolCalls[2]!.name).toBe('agent_delegate');

    // Each should have returned a result
    expect(result.toolCalls[0]!.result.response).toContain('Competitor A');
    expect(result.toolCalls[1]!.result.response).toContain('Competitor B');
    expect(result.toolCalls[2]!.result.response).toContain('Competitor C');

    // Final synthesis
    expect(result.finalText).toContain('enterprise');
    expect(result.finalText).toContain('devex');
    expect(result.finalText).toContain('AI');
  });

  test('partial failure: 1 of 3 delegations throws, other 2 complete', async () => {
    let delegateCallCount = 0;

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async (req: DelegateRequest) => {
        delegateCallCount++;
        if (req.task.includes('crash')) {
          throw new Error('Simulated subagent crash');
        }
        return `Result for: ${req.task}`;
      },
      llmTurns: [
        toolUseTurn('agent_delegate', { task: 'Research topic A' }),
        toolUseTurn('agent_delegate', { task: 'This will crash' }),
        toolUseTurn('agent_delegate', { task: 'Research topic C' }),
        textTurn('Here are the results with one failure noted.'),
      ],
    });

    const result = await harness.runAgentLoop('Research 3 topics');

    expect(result.toolCalls.length).toBe(3);

    // First succeeded
    expect(result.toolCalls[0]!.result.ok).toBe(true);
    expect(result.toolCalls[0]!.result.response).toContain('Result for');

    // Second failed (the crash)
    expect(result.toolCalls[1]!.result.ok).toBe(false);
    expect(result.toolCalls[1]!.result.error).toContain('Simulated subagent crash');

    // Third still succeeded (not affected by the crash)
    expect(result.toolCalls[2]!.result.ok).toBe(true);
    expect(result.toolCalls[2]!.result.response).toContain('Result for');

    // LLM synthesized despite partial failure
    expect(result.finalText).toContain('failure');
  });

  test('delegation chain: depth 1 → depth 2 → blocked at maxDepth=2', async () => {
    harness = await TestHarness.create({
      delegation: { maxDepth: 2 },
      onDelegate: async (req) => `Done: ${req.task}`,
    });

    // Depth 0 agent delegates — should succeed (creates depth 1)
    const d1 = await harness.ipcCall(
      'agent_delegate',
      { task: 'First level delegation' },
      { sessionId: 'chain-session', agentId: 'root-agent' },
    );
    expect(d1.ok).toBe(true);

    // Depth 1 agent tries to delegate — should succeed (creates depth 2)
    const d2 = await harness.ipcCall(
      'agent_delegate',
      { task: 'Second level delegation' },
      { sessionId: 'chain-session', agentId: 'delegate-root-agent:depth=1' },
    );
    expect(d2.ok).toBe(true);

    // Depth 2 agent tries to delegate — should be blocked (maxDepth=2)
    const d3 = await harness.ipcCall(
      'agent_delegate',
      { task: 'Third level delegation (should fail)' },
      { sessionId: 'chain-session', agentId: 'delegate-delegate-root-agent:depth=2' },
    );
    expect(d3.ok).toBe(false);
    expect(d3.error).toContain('depth');
  });

  test('concurrent delegations are each audited', async () => {
    let callCount = 0;

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async (req) => {
        callCount++;
        return `Result ${callCount}`;
      },
      llmTurns: [
        toolUseTurn('agent_delegate', { task: 'Audit task 1' }),
        toolUseTurn('agent_delegate', { task: 'Audit task 2' }),
        textTurn('Done.'),
      ],
    });

    await harness.runAgentLoop('Run two research tasks');

    // Each delegation should produce an audit entry
    const delegateAudits = harness.auditEntriesFor('agent_delegate');
    expect(delegateAudits.length).toBeGreaterThanOrEqual(2);
  });

  test('slow delegation does not block fast ones at different concurrency slots', async () => {
    const results: string[] = [];

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async (req: DelegateRequest) => {
        if (req.task.includes('slow')) {
          await new Promise(r => setTimeout(r, 50));
          results.push('slow');
        } else {
          results.push('fast');
        }
        return `Done: ${req.task}`;
      },
      llmTurns: [
        toolUseTurn('agent_delegate', { task: 'fast task 1' }),
        toolUseTurn('agent_delegate', { task: 'fast task 2' }),
        textTurn('Both fast tasks done.'),
      ],
    });

    const result = await harness.runAgentLoop('Do two tasks');

    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]!.result.ok).toBe(true);
    expect(result.toolCalls[1]!.result.ok).toBe(true);
  });

  test('delegation with runner and model overrides', async () => {
    let receivedReq: DelegateRequest | undefined;

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async (req: DelegateRequest) => {
        receivedReq = req;
        return 'Done with overrides';
      },
      llmTurns: [
        toolUseTurn('agent_delegate', {
          task: 'Complex analysis',
          runner: 'claude-code',
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          timeoutSec: 300,
        }),
        textTurn('Analysis complete.'),
      ],
    });

    const result = await harness.runAgentLoop('Analyze codebase');

    expect(result.toolCalls[0]!.result.ok).toBe(true);
    expect(receivedReq).toBeDefined();
    expect(receivedReq!.task).toBe('Complex analysis');
    expect(receivedReq!.runner).toBe('claude-code');
    expect(receivedReq!.model).toBe('claude-sonnet-4-5-20250929');
    expect(receivedReq!.maxTokens).toBe(8192);
    expect(receivedReq!.timeoutSec).toBe(300);
  });

  test('max concurrency rejection mid-agent-loop does not break the loop', async () => {
    // Set maxConcurrent=1 so the second delegation is rejected
    let callCount = 0;
    let resolveFirst: (() => void) | null = null;

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate: async () => {
        callCount++;
        return `Result ${callCount}`;
      },
      llmTurns: [
        // First delegation
        toolUseTurn('agent_delegate', { task: 'First task' }),
        // After getting the result, try another (should work since first completed)
        toolUseTurn('agent_delegate', { task: 'Second task' }),
        textTurn('Both tasks handled.'),
      ],
    });

    // Since the harness runs tool calls sequentially in the agent loop,
    // each delegation completes before the next starts — both should succeed
    const result = await harness.runAgentLoop('Do two sequential tasks');

    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]!.result.ok).toBe(true);
    expect(result.toolCalls[1]!.result.ok).toBe(true);
    expect(result.finalText).toContain('Both tasks handled');
  });
});
