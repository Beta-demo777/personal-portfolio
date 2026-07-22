import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import {
  GracefulShutdownTimeoutError,
  startHttpServer,
  type ApplicationLifecycle,
} from './lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('graceful shutdown stops listening and waits for an active request', async () => {
  const requestStarted = deferred();
  const releaseRequest = deferred();
  const requestFinished = deferred();
  const app = express();
  app.get('/slow', async (_req, res) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    res.once('finish', requestFinished.resolve);
    res.send('complete');
  });
  const lifecycle: ApplicationLifecycle = {
    app,
    beginDrain() {},
    whenIdle: () => requestFinished.promise,
    close: async () => {},
  };
  const runtime = await startHttpServer(lifecycle, {
    host: '127.0.0.1',
    port: 0,
    shutdownTimeoutMs: 1_000,
  });
  const address = runtime.server.address();
  assert.ok(address && typeof address !== 'string');

  const responsePromise = fetch(`http://127.0.0.1:${address.port}/slow`);
  await requestStarted.promise;
  const shutdownPromise = runtime.shutdown('SIGTERM');
  assert.equal(runtime.server.listening, false);

  let shutdownFinished = false;
  void shutdownPromise.then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);

  releaseRequest.resolve();
  const response = await responsePromise;
  assert.equal(await response.text(), 'complete');
  await shutdownPromise;
  assert.equal(shutdownFinished, true);
});

test('only the timeout path force-closes active connections', async () => {
  const requestStarted = deferred();
  const app = express();
  app.get('/never', async (_req, res) => {
    requestStarted.resolve();
    await new Promise(() => {});
    res.end();
  });
  const lifecycle: ApplicationLifecycle = {
    app,
    beginDrain() {},
    whenIdle: async () => new Promise(() => {}),
    close: async () => {},
  };
  const runtime = await startHttpServer(lifecycle, {
    host: '127.0.0.1',
    port: 0,
    shutdownTimeoutMs: 50,
  });
  const address = runtime.server.address();
  assert.ok(address && typeof address !== 'string');
  const request = fetch(`http://127.0.0.1:${address.port}/never`);
  await requestStarted.promise;

  let forceCloseCalls = 0;
  const originalForceClose = runtime.server.closeAllConnections.bind(runtime.server);
  runtime.server.closeAllConnections = () => {
    forceCloseCalls += 1;
    originalForceClose();
  };

  await assert.rejects(
    runtime.shutdown('SIGTERM'),
    (error: unknown) => error instanceof GracefulShutdownTimeoutError,
  );
  assert.equal(forceCloseCalls, 1);
  await assert.rejects(request);
});
