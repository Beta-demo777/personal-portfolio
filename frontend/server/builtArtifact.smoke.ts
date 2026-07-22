import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import { blogPostPath } from '../src/routing';

const FRONTEND_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVER_ARTIFACT = fileURLToPath(new URL('../server-dist/server.mjs', import.meta.url));

async function listenOnLoopback(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  const port = await listenOnLoopback(server);
  await closeServer(server);
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exitPromise = once(child, 'exit');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    exitPromise.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 3_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (!exited) {
    child.kill('SIGKILL');
    await exitPromise;
  }
}

async function waitUntilReady(
  child: ChildProcess,
  healthUrl: string,
  readOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Built server exited before becoming ready:\n${readOutput()}`);
    }

    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Startup can race the first few probes.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Built server did not become ready:\n${readOutput()}`);
}

async function waitUntil(
  predicate: () => boolean,
  failureMessage: () => string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(failureMessage());
}

test('built production server renders an article deep link with SEO metadata', { timeout: 30_000 }, async (t) => {
  const contentBody = JSON.stringify(DEFAULT_SITE_CONTENT);
  const cms = createServer((request, response) => {
    if (request.url === '/api/v1/content') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(contentBody),
        ETag: '"built-smoke-content"',
      });
      response.end(contentBody);
      return;
    }
    response.writeHead(404).end();
  });
  const cmsPort = await listenOnLoopback(cms);
  const serverPort = await findAvailablePort();
  const publicOrigin = `http://127.0.0.1:${serverPort}`;

  let output = '';
  const serverProcess = spawn(process.execPath, [SERVER_ARTIFACT], {
    cwd: FRONTEND_ROOT,
    env: {
      NODE_ENV: 'production',
      PORT: String(serverPort),
      PUBLIC_ORIGIN: publicOrigin,
      CMS_INTERNAL_ORIGIN: `http://127.0.0.1:${cmsPort}`,
      CMS_FETCH_TIMEOUT_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appendOutput = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-20_000);
  };
  serverProcess.stdout?.on('data', appendOutput);
  serverProcess.stderr?.on('data', appendOutput);

  t.after(async () => {
    await stopChild(serverProcess);
    await closeServer(cms);
  });

  await waitUntilReady(serverProcess, `${publicOrigin}/healthz`, () => output);

  const adminResponse = await fetch(`${publicOrigin}/admin`, {
    headers: { Accept: 'text/html' },
  });
  assert.equal(adminResponse.status, 200, output);
  assert.equal(adminResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(adminResponse.headers.get('vary'), 'Cookie');

  const post = DEFAULT_SITE_CONTENT.blogPosts[0];
  const articlePath = blogPostPath(post);
  const response = await fetch(`${publicOrigin}${articlePath}`, {
    headers: { Accept: 'text/html' },
  });
  const html = await response.text();

  assert.equal(response.status, 200, output);
  assert.match(
    html,
    /如何解决这个问题？答案是 <strong[^>]*>微交互（Micro-interactions）<\/strong>/,
    'article Markdown body was not server-rendered',
  );
  assert.ok(
    html.includes(`<link rel="canonical" href="${publicOrigin}${articlePath}" />`),
    'canonical metadata is missing',
  );
  assert.ok(
    html.includes('<meta property="og:type" content="article" />'),
    'article Open Graph metadata is missing',
  );

  const jsonLdMatch = html.match(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/);
  assert.ok(jsonLdMatch, 'JSON-LD metadata is missing');
  const jsonLd = JSON.parse(jsonLdMatch[1]) as {
    '@graph'?: Array<Record<string, unknown>>;
  };
  const article = jsonLd['@graph']?.find((item) => item['@type'] === 'BlogPosting');
  assert.equal(article?.headline, post.seoTitle || post.title);
  assert.equal(article?.mainEntityOfPage, `${publicOrigin}${articlePath}`);
});

test('built server drains an in-flight SSR request after a real SIGTERM', { timeout: 30_000 }, async (t) => {
  const contentBody = JSON.stringify(DEFAULT_SITE_CONTENT);
  let releaseCmsResponse!: () => void;
  let markCmsRequestStarted!: () => void;
  const cmsRequestStarted = new Promise<void>((resolve) => {
    markCmsRequestStarted = resolve;
  });
  const cmsResponseReleased = new Promise<void>((resolve) => {
    releaseCmsResponse = resolve;
  });
  const cms = createServer((request, response) => {
    if (request.url !== '/api/v1/content') {
      response.writeHead(404).end();
      return;
    }
    markCmsRequestStarted();
    void cmsResponseReleased.then(() => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(contentBody),
      });
      response.end(contentBody);
    });
  });
  const cmsPort = await listenOnLoopback(cms);
  const serverPort = await findAvailablePort();
  const publicOrigin = `http://127.0.0.1:${serverPort}`;
  let output = '';
  const serverProcess = spawn(process.execPath, [SERVER_ARTIFACT], {
    cwd: FRONTEND_ROOT,
    env: {
      NODE_ENV: 'production',
      PORT: String(serverPort),
      PUBLIC_ORIGIN: publicOrigin,
      CMS_INTERNAL_ORIGIN: `http://127.0.0.1:${cmsPort}`,
      CMS_FETCH_TIMEOUT_MS: '10000',
      SHUTDOWN_TIMEOUT_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appendOutput = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-20_000);
  };
  serverProcess.stdout?.on('data', appendOutput);
  serverProcess.stderr?.on('data', appendOutput);

  t.after(async () => {
    releaseCmsResponse();
    await stopChild(serverProcess);
    await closeServer(cms);
  });

  await waitUntilReady(serverProcess, `${publicOrigin}/healthz`, () => output);
  const inFlightResponse = fetch(`${publicOrigin}/`, {
    headers: { Accept: 'text/html' },
  });
  await cmsRequestStarted;

  const exitPromise = once(serverProcess, 'exit');
  assert.equal(serverProcess.kill('SIGTERM'), true);
  await waitUntil(
    () => output.includes('Received SIGTERM'),
    () => `Server did not begin graceful shutdown:\n${output}`,
  );
  await assert.rejects(
    fetch(`${publicOrigin}/healthz`, { signal: AbortSignal.timeout(1_000) }),
    'the listener still accepted a new request after SIGTERM',
  );

  let exitedBeforeRelease = false;
  await Promise.race([
    exitPromise.then(() => {
      exitedBeforeRelease = true;
    }),
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  assert.equal(exitedBeforeRelease, false, output);

  releaseCmsResponse();
  const response = await inFlightResponse;
  assert.equal(response.status, 200, output);
  assert.match(await response.text(), /id="app-root"/);

  const [exitCode, signal] = await exitPromise;
  assert.equal(exitCode, 0, output);
  assert.equal(signal, null, output);
  assert.doesNotMatch(output, /Graceful shutdown timed out/);
});
