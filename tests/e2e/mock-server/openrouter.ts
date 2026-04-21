import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALL_TURNS, type ScriptedTurn } from '../scripts/index.js';

let turnIndex = 0;

export function resetOpenRouter(): void {
  turnIndex = 0;
}

export function handleOpenRouter(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';

  if (url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ id: 'openrouter/google/gemini-3-flash-preview', object: 'model' }],
    }));
    return;
  }

  if (url.startsWith('/v1/chat/completions') && req.method === 'POST') {
    handleChatCompletion(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function handleChatCompletion(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages ?? [];

    // Detect tool-result follow-ups: if the last message is a tool result,
    // we have two possible behaviors:
    //   (a) Scripted multi-turn chain — try to match the tool-result content
    //       against any turn's `matchToolResult` pattern. If one matches,
    //       emit that turn's response (which may itself be another tool_call,
    //       driving the next step in the chain).
    //   (b) Fallback (preserves legacy behavior for tests 1-17) — no match →
    //       return a content-only summary so the agent doesn't loop forever
    //       by re-matching the same user message and re-emitting the same
    //       tool_call.
    const lastMsg = messages[messages.length - 1];
    const isToolResultFollowUp = lastMsg?.role === 'tool';
    if (isToolResultFollowUp) {
      const toolContent = lastMsg.content ?? '';
      const toolText = typeof toolContent === 'string'
        ? toolContent
        : JSON.stringify(toolContent);

      // (a) Scripted match against `matchToolResult`.
      let chainedTurn: ScriptedTurn | undefined;
      for (const t of ALL_TURNS) {
        if (!t.matchToolResult) continue;
        const matched = typeof t.matchToolResult === 'string'
          ? toolText.toLowerCase().includes(t.matchToolResult.toLowerCase())
          : t.matchToolResult.test(toolText);
        if (matched) {
          chainedTurn = t;
          break;
        }
      }
      if (chainedTurn) {
        sendResponse(res, body, chainedTurn);
        return;
      }

      // (b) Fallback — content-only summary.
      const summary = `Done. Tool returned: ${toolText.slice(0, 200)}`;
      const followUpTurn: ScriptedTurn = {
        match: '',
        response: { content: summary },
      };
      sendResponse(res, body, followUpTurn);
      return;
    }

    // Find last user message
    let lastUserMsg = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        lastUserMsg = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            : '';
        break;
      }
    }

    // Match against scripted turns - try from current index first, then search all
    let turn: ScriptedTurn | undefined;

    // First try matching from current position forward
    for (let i = turnIndex; i < ALL_TURNS.length; i++) {
      const t = ALL_TURNS[i];
      const match = typeof t.match === 'string'
        ? lastUserMsg.toLowerCase().includes(t.match.toLowerCase())
        : t.match.test(lastUserMsg);
      if (match) {
        turn = t;
        turnIndex = i + 1;
        break;
      }
    }

    // Fallback: search all turns
    if (!turn) {
      for (const t of ALL_TURNS) {
        const match = typeof t.match === 'string'
          ? lastUserMsg.toLowerCase().includes(t.match.toLowerCase())
          : t.match.test(lastUserMsg);
        if (match) {
          turn = t;
          break;
        }
      }
    }

    // Default response if no match
    if (!turn) {
      turn = {
        match: '',
        response: { content: 'I understand. How can I help you further?' },
      };
    }

    sendResponse(res, body, turn);
  });
}

function sendResponse(res: ServerResponse, body: any, turn: ScriptedTurn): void {
  const isStreaming = body.stream === true;

  if (!isStreaming) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: turn.response.content ?? null,
          tool_calls: turn.response.tool_calls ?? undefined,
        },
        finish_reason: turn.finishReason ?? (turn.response.tool_calls ? 'tool_calls' : 'stop'),
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
    return;
  }

  // Streaming SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const chatId = `chatcmpl-test-${Date.now()}`;

  sendSSE(res, {
    id: chatId,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  if (turn.response.content) {
    const words = turn.response.content.split(' ');
    for (let i = 0; i < words.length; i++) {
      const word = (i > 0 ? ' ' : '') + words[i];
      sendSSE(res, {
        id: chatId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
      });
    }
  }

  if (turn.response.tool_calls) {
    for (let i = 0; i < turn.response.tool_calls.length; i++) {
      const tc = turn.response.tool_calls[i];
      sendSSE(res, {
        id: chatId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      });
      sendSSE(res, {
        id: chatId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: i,
              function: { arguments: tc.function.arguments },
            }],
          },
          finish_reason: null,
        }],
      });
    }
  }

  const finishReason = turn.finishReason ?? (turn.response.tool_calls ? 'tool_calls' : 'stop');
  sendSSE(res, {
    id: chatId,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

function sendSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
