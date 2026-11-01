import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chat } from '../src/llm-call-chat.js';

describe('what the call sends and reads back', () => {
  let srv: Server;
  let base = '';
  const bodies: Record<string, unknown>[] = [];

  beforeAll(async () => {
    srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        const said = JSON.stringify(body.messages);
        if (body.reasoning_effort === 'medium') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ error: { message: 'unknown parameter: reasoning_effort' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const usage = said.includes('REPORT')
          ? { prompt_tokens: 40, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } }
          : said.includes('RESPONSES')
            ? { prompt_tokens: 40, completion_tokens: 900, output_tokens_details: { reasoning_tokens: 650 } }
            : { prompt_tokens: 40, completion_tokens: 900 };
        res.end(JSON.stringify({ choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }], content: [{ type: 'text', text: 'the answer' }], usage }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  const openai = () => ({ id: 'x', label: 'Fake', kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: 'key-1234567890' }) as never;
  const anthropic = () => ({ id: 'y', label: 'Fake', kind: 'anthropic-messages', baseUrl: base, apiKey: 'key-1234567890' }) as never;

  it('sends reasoning_effort only when a level is set, like temperature and top-p', async () => {
    bodies.length = 0;
    await chat(openai(), 'm', 'sys', 'hello', { maxTokens: 1000 });
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort');
    await chat(openai(), 'm', 'sys', 'hello', { maxTokens: 1000, reasoningEffort: 'low' });
    expect(bodies.at(-1)).toMatchObject({ reasoning_effort: 'low', model: 'm', max_tokens: 1000 });
  });

  it('never sends it in the Anthropic format, which thinks in its own way', async () => {
    bodies.length = 0;
    await chat(anthropic(), 'm', 'sys', 'hello', { maxTokens: 1000, reasoningEffort: 'low' });
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort');
    expect(bodies.at(-1)).toHaveProperty('system', 'sys');
  });

  it('reads the thinking tokens the provider reports, in either of the two shapes, and says nothing when it reports none', async () => {
    expect(await chat(openai(), 'm', 'sys', 'REPORT please', { maxTokens: 1000 })).toMatchObject({ inputTokens: 40, outputTokens: 900, reasoningTokens: 700 });
    expect(await chat(openai(), 'm', 'sys', 'RESPONSES please', { maxTokens: 1000 })).toMatchObject({ outputTokens: 900, reasoningTokens: 650 });
    const plain = await chat(openai(), 'm', 'sys', 'hello', { maxTokens: 1000 });
    expect(plain.outputTokens).toBe(900);
    expect(plain).not.toHaveProperty('reasoningTokens');
  });

  it('when the provider refuses the setting, says which setting was sent and how to take it back', async () => {
    await expect(chat(openai(), 'm', 'sys', 'hello', { maxTokens: 1000, reasoningEffort: 'medium' })).rejects.toThrow(
      /rejected the request \(HTTP 400: unknown parameter: reasoning_effort\)\. This job sends the reasoning effort "medium".*"Provider default" in Admin → LLM/,
    );
  });
});
