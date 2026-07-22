import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_AGENT_HISTORY_CHARS,
  MAX_AGENT_HISTORY_MESSAGES,
  MAX_AGENT_USER_MESSAGE_CHARS,
} from '../src/api/agent';
import { loadServerConfig } from './config';

test('loads a complete immutable configuration from the supplied environment', () => {
  const environment = {
    NODE_ENV: 'production',
    PORT: '4321',
    TRUST_PROXY_HOPS: '1',
    PUBLIC_ORIGIN: 'https://portfolio.test',
    CMS_INTERNAL_ORIGIN: 'http://cms:8000',
    AGENT_RATE_REQUESTS: '9',
    SHUTDOWN_TIMEOUT_MS: '2500',
  };
  const config = loadServerConfig(environment, '/srv/frontend');

  assert.equal(config.environment, 'production');
  assert.equal(config.listener.port, 4321);
  assert.equal(config.listener.shutdownTimeoutMs, 2500);
  assert.equal(config.publicSite.publicOrigin, 'https://portfolio.test');
  assert.equal(config.publicSite.cmsOrigin, 'http://cms:8000');
  assert.equal(config.agent.rateRequestsPerWindow, 9);
  assert.equal(config.rootDirectory, '/srv/frontend');

  environment.PORT = '9000';
  assert.equal(config.listener.port, 4321);
  assert.equal(Object.isFrozen(config), true);
});

test('keeps server limits compatible with the browser and deployment boundaries', () => {
  const config = loadServerConfig({ NODE_ENV: 'production' });
  assert.equal(config.agent.maxBodyBytes, 65_536);
  assert.equal(config.agent.maxMessages, MAX_AGENT_HISTORY_MESSAGES);
  assert.equal(config.agent.maxUserMessageChars, MAX_AGENT_USER_MESSAGE_CHARS);
  assert.equal(config.agent.maxHistoryChars, MAX_AGENT_HISTORY_CHARS);
  assert.equal(config.publicSite.contentLimitBytes, 3 * 1024 * 1024);
  assert.equal(config.publicSite.fetchTimeoutMs, 3_000);
  assert.equal(config.listener.shutdownTimeoutMs, 18_000);
  assert.equal(config.trustProxyHops, 1);

  const rejected: Array<[Record<string, string>, RegExp]> = [
    [{ AGENT_MAX_BODY_BYTES: '65535' }, /AGENT_MAX_BODY_BYTES/],
    [{ AGENT_MAX_BODY_BYTES: '65537' }, /AGENT_MAX_BODY_BYTES/],
    [{ AGENT_MAX_MESSAGES: '11' }, /AGENT_MAX_MESSAGES/],
    [{ AGENT_MAX_MESSAGE_CHARS: '10501' }, /AGENT_MAX_MESSAGE_CHARS/],
    [{ AGENT_MAX_USER_MESSAGE_CHARS: '1499' }, /AGENT_MAX_USER_MESSAGE_CHARS/],
    [{ AGENT_MAX_HISTORY_CHARS: '11999' }, /AGENT_MAX_HISTORY_CHARS/],
    [{ CMS_CONTENT_LIMIT_BYTES: '2097151' }, /CMS_CONTENT_LIMIT_BYTES/],
    [{ CMS_FETCH_TIMEOUT_MS: '20001' }, /CMS_FETCH_TIMEOUT_MS/],
    [{ SHUTDOWN_TIMEOUT_MS: '18001' }, /SHUTDOWN_TIMEOUT_MS/],
    [{ NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }, /TRUST_PROXY_HOPS must be 1/],
    [{ NODE_ENV: 'production', TRUST_PROXY_HOPS: '2' }, /TRUST_PROXY_HOPS/],
  ];
  for (const [environment, expected] of rejected) {
    assert.throws(() => loadServerConfig(environment), expected);
  }
});

test('validates related limits and unsupported process modes before startup', () => {
  assert.throws(
    () => loadServerConfig({
      NODE_ENV: 'test',
      AGENT_MAX_MESSAGE_CHARS: '1499',
    }),
    /AGENT_MAX_USER_MESSAGE_CHARS cannot exceed AGENT_MAX_MESSAGE_CHARS/,
  );
  assert.throws(
    () => loadServerConfig({
      AGENT_MAX_MESSAGE_CHARS: '10500',
      AGENT_MAX_USER_MESSAGE_CHARS: '8000',
      AGENT_MAX_HISTORY_CHARS: '12000',
    }),
    /must fit one assistant message and the next user message/,
  );
  assert.throws(
    () => loadServerConfig({ NODE_ENV: 'staging' }),
    /NODE_ENV must be one of/,
  );
  assert.throws(
    () => loadServerConfig({ PUBLIC_ORIGIN: 'https://portfolio.test/path' }),
    /PUBLIC_ORIGIN must be an absolute HTTP\(S\) origin/,
  );
});
