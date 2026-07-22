import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_HISTORY_CHARS,
  MAX_AGENT_HISTORY_MESSAGES,
  agentErrorMessage,
  agentReply,
  boundedAgentHistory,
} from './agent';

describe('agent API parsing', () => {
  it('uses structured rate-limit information', async () => {
    const response = new Response(JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '17' },
    });

    await expect(agentErrorMessage(response)).resolves.toBe('请求过于频繁，请在 17 秒后重试。');
  });

  it('maps known capacity errors and safely falls back for invalid bodies', async () => {
    const busy = new Response(JSON.stringify({ error: { code: 'AI_BUSY' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
    const invalid = new Response('not json', { status: 502 });

    await expect(agentErrorMessage(busy)).resolves.toContain('请求较多');
    await expect(agentErrorMessage(invalid)).resolves.toContain('HTTP 502');
  });

  it('maps the exact timeout and unavailable codes returned by the BFF', async () => {
    const timeout = new Response(JSON.stringify({ error: { code: 'AI_UPSTREAM_TIMEOUT' } }), {
      status: 504,
      headers: { 'Content-Type': 'application/json' },
    });
    const unavailable = new Response(JSON.stringify({ error: { code: 'AI_UNAVAILABLE' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(agentErrorMessage(timeout)).resolves.toContain('超时');
    await expect(agentErrorMessage(unavailable)).resolves.toContain('暂时不可用');
  });

  it('accepts only non-empty message responses', () => {
    expect(agentReply({ message: '  answer  ' })).toBe('answer');
    expect(agentReply({ message: '   ' })).toBeNull();
    expect(agentReply({ message: 42 })).toBeNull();
    expect(agentReply(null)).toBeNull();
  });

  it('keeps only the newest history accepted by the server contract', () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' as const : 'user' as const,
      content: `message-${index}`,
    }));

    const bounded = boundedAgentHistory(messages);

    expect(bounded).toHaveLength(MAX_AGENT_HISTORY_MESSAGES);
    expect(bounded[0]?.content).toBe('message-4');
    expect(bounded.at(-1)?.content).toBe('message-15');
    expect(messages).toHaveLength(16);
  });

  it('drops older turns before exceeding the history character budget', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' as const : 'user' as const,
      content: String(index).repeat(3_500),
    }));

    const bounded = boundedAgentHistory(messages);

    expect(bounded.map((message) => message.content[0])).toEqual(['3', '4', '5']);
    expect(bounded.reduce((total, message) => total + message.content.length, 0))
      .toBeLessThanOrEqual(MAX_AGENT_HISTORY_CHARS);
  });
});
