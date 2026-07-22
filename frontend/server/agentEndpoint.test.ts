import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';
import type OpenAI from 'openai';
import { createApp, type ApplicationDependencies } from '../server';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import { createDeepSeekClient } from './agent';
import { loadServerConfig, type Environment } from './config';

const TEST_ENVIRONMENT: Environment = {
  NODE_ENV: 'test',
  AI_API_KEY: '',
  AI_API_KEY_FILE: '',
  AI_MODEL: 'test-model',
  TRUST_PROXY_HOPS: '0',
};

interface TestServer {
  origin: string;
  listener: Server;
  close: () => Promise<void>;
}

async function startTestServer(
  environment: Environment = TEST_ENVIRONMENT,
  dependencies: ApplicationDependencies = {},
): Promise<TestServer> {
  const application = await createApp(loadServerConfig(environment), dependencies);
  const listener = application.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    listener,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => error ? reject(error) : resolve());
      });
      await application.close();
    },
  };
}

async function withTestServer(
  run: (server: TestServer) => Promise<void>,
  environment: Environment = TEST_ENVIRONMENT,
): Promise<void> {
  const server = await startTestServer(environment);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

async function post(origin: string, body: string, contentType = 'application/json'): Promise<Response> {
  return fetch(`${origin}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = await response.json() as { error?: { code?: string } };
  return payload.error?.code;
}

test('constructs the AI client with the fixed DeepSeek endpoint and request budget', () => {
  const client = createDeepSeekClient('test-key', 1_234);
  assert.equal(client.baseURL, 'https://api.deepseek.com');
  assert.equal(client.timeout, 1_234);
  assert.equal(client.maxRetries, 0);
});

test('marks every administrator response private before routing', async () => {
  await withTestServer(async ({ origin }) => {
    const response = await fetch(`${origin}/admin/probe`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  });
});

test('preserves valid edge request IDs and replaces invalid values', async () => {
  await withTestServer(async ({ origin }) => {
    const supplied = 'edge-request-12345678';
    const accepted = await fetch(`${origin}/healthz`, {
      headers: { 'X-Request-ID': supplied },
    });
    assert.equal(accepted.headers.get('x-request-id'), supplied);

    const replaced = await fetch(`${origin}/healthz`, {
      headers: { 'X-Request-ID': 'invalid request id' },
    });
    assert.match(replaced.headers.get('x-request-id') || '', /^[0-9a-f]{32}$/);
  });
});

test('rejects unsupported content types and invalid chat payloads', async () => {
  await withTestServer(async ({ origin }) => {
    const unsupported = await post(origin, '{}', 'text/plain');
    assert.equal(unsupported.status, 415);
    assert.equal(await errorCode(unsupported), 'UNSUPPORTED_MEDIA_TYPE');

    const invalid = await post(origin, JSON.stringify({ messages: [] }));
    assert.equal(invalid.status, 400);
    assert.equal(await errorCode(invalid), 'INVALID_REQUEST');
  });
});

test('normalizes malformed and oversized JSON into stable API errors', async () => {
  await withTestServer(async ({ origin }) => {
    const malformed = await post(origin, '{');
    assert.equal(malformed.status, 400);
    assert.equal(await errorCode(malformed), 'INVALID_JSON');

    const oversized = await post(origin, JSON.stringify({ messages: [{
      role: 'user',
      content: 'x'.repeat(70_000),
    }] }));
    assert.equal(oversized.status, 413);
    assert.equal(await errorCode(oversized), 'PAYLOAD_TOO_LARGE');
  });
});

test('returns the deterministic local response when the AI API is not configured', async () => {
  await withTestServer(async ({ origin }) => {
    const response = await post(origin, JSON.stringify({
      messages: [{ role: 'user', content: '介绍一下这个作品集' }],
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json() as { message?: string };
    assert.match(payload.message || '', /AI_API_KEY/);
  });
});

test('enforces the per-client rate limit with Retry-After metadata', async () => {
  await withTestServer(async ({ origin }) => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
    const accepted = await post(origin, body);
    assert.equal(accepted.status, 200);

    const limited = await post(origin, body);
    assert.equal(limited.status, 429);
    assert.equal(await errorCode(limited), 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
  }, { ...TEST_ENVIRONMENT, AGENT_RATE_REQUESTS: '1' });
});

test('application factory isolates mutable quota state between instances', async () => {
  const environment = { ...TEST_ENVIRONMENT, AGENT_RATE_REQUESTS: '1' };
  const first = await startTestServer(environment);
  const second = await startTestServer(environment);
  try {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal((await post(first.origin, body)).status, 200);
    assert.equal((await post(first.origin, body)).status, 429);
    assert.equal((await post(second.origin, body)).status, 200);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('uses a validated stale CMS snapshot for AI facts while excluding drafts', async () => {
  const content = structuredClone(DEFAULT_SITE_CONTENT);
  content.blogPosts.push({
    ...content.blogPosts[0],
    id: 'private-draft',
    title: 'PRIVATE_DRAFT_MUST_NOT_REACH_AI_PROVIDER',
    status: 'draft',
  });
  let systemInstruction = '';
  let completionRequest: {
    model?: string;
    messages?: Array<{ role: string; content?: string }>;
    thinking?: { type?: string };
    max_tokens?: number;
    stream?: boolean;
  } = {};
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: { messages: Array<{ role: string; content?: string }> }) => {
          completionRequest = request;
          systemInstruction = request.messages.find((message) => message.role === 'system')?.content || '';
          return { choices: [{ message: { content: 'verified stale answer' } }] };
        },
      },
    },
  } as unknown as OpenAI;
  const server = await startTestServer(
    { ...TEST_ENVIRONMENT, AI_API_KEY: 'test-key' },
    {
      createClient: () => fakeClient,
      getPublicContent: async () => ({ content, status: 'stale' }),
    },
  );
  try {
    const response = await post(server.origin, JSON.stringify({
      messages: [{ role: 'user', content: 'What is public?' }],
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { message: string }).message, 'verified stale answer');
    assert.match(systemInstruction, new RegExp(content.personalInfo.name));
    assert.doesNotMatch(systemInstruction, /PRIVATE_DRAFT_MUST_NOT_REACH_AI_PROVIDER/);
    assert.equal(completionRequest.model, 'test-model');
    assert.deepEqual(completionRequest.thinking, { type: 'disabled' });
    assert.equal(completionRequest.max_tokens, 512);
    assert.equal(completionRequest.stream, false);
    assert.deepEqual(completionRequest.messages?.map((message) => message.role), ['system', 'user']);
  } finally {
    await server.close();
  }
});

test('bounds AI replies so the next browser turn remains valid', async () => {
  const upstreamReply = `${'x'.repeat(1_498)}😀tail`;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: upstreamReply } }] }),
      },
    },
  } as unknown as OpenAI;
  const server = await startTestServer(
    {
      ...TEST_ENVIRONMENT,
      AI_API_KEY: 'test-key',
      AGENT_MAX_MESSAGE_CHARS: '1500',
    },
    {
      createClient: () => fakeClient,
      getPublicContent: async () => ({ content: DEFAULT_SITE_CONTENT, status: 'ready' }),
    },
  );
  try {
    const firstResponse = await post(server.origin, JSON.stringify({
      messages: [{ role: 'user', content: 'First question' }],
    }));
    assert.equal(firstResponse.status, 200);
    const firstReply = (await firstResponse.json() as { message: string }).message;
    assert.ok(firstReply.length <= 1_500);
    assert.equal(firstReply.endsWith('…'), true);
    assert.equal(firstReply.includes('\uFFFD'), false);

    const nextResponse = await post(server.origin, JSON.stringify({
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: firstReply },
        { role: 'user', content: 'Continue' },
      ],
    }));
    assert.equal(nextResponse.status, 200);
  } finally {
    await server.close();
  }
});

test('fails closed when no validated CMS snapshot is available to the AI', async () => {
  let clientCreations = 0;
  const server = await startTestServer(
    { ...TEST_ENVIRONMENT, AI_API_KEY: 'test-key' },
    {
      createClient: () => {
        clientCreations += 1;
        return {} as OpenAI;
      },
      getPublicContent: async () => ({ content: DEFAULT_SITE_CONTENT, status: 'unavailable' }),
    },
  );
  try {
    const response = await post(server.origin, JSON.stringify({
      messages: [{ role: 'user', content: 'What is public?' }],
    }));
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), 'AI_UNAVAILABLE');
    assert.equal(clientCreations, 0);
  } finally {
    await server.close();
  }
});
