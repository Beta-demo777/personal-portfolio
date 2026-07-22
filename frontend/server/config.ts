import { readOptionalSecret } from './runtimeConfig';

export type Environment = Readonly<Record<string, string | undefined>>;
export type ServerEnvironment = 'development' | 'production' | 'test';

export interface AgentConfig {
  apiKey?: string;
  model: string;
  maxBodyBytes: number;
  maxMessages: number;
  maxMessageChars: number;
  maxUserMessageChars: number;
  maxHistoryChars: number;
  maxOutputTokens: number;
  upstreamTimeoutMs: number;
  maxConcurrentRequests: number;
  rateWindowMs: number;
  rateRequestsPerWindow: number;
  dailyRequestsPerIp: number;
  globalDailyRequests: number;
  maxTrackedIps: number;
}

export interface PublicSiteConfig {
  publicOrigin: string;
  cmsOrigin: string;
  fetchTimeoutMs: number;
  contentLimitBytes: number;
  cacheTtlMs: number;
  staleTtlMs: number;
}

export interface ListenerConfig {
  host: string;
  port: number;
  shutdownTimeoutMs: number;
}

export interface ServerConfig {
  environment: ServerEnvironment;
  rootDirectory: string;
  trustProxyHops: number;
  agent: Readonly<AgentConfig>;
  publicSite: Readonly<PublicSiteConfig>;
  listener: Readonly<ListenerConfig>;
}

const EDGE_AGENT_BODY_BYTES = 64 * 1024;
const BROWSER_AGENT_MESSAGES = 12;
const BROWSER_AGENT_USER_MESSAGE_CHARS = 1_500;
const BROWSER_AGENT_HISTORY_CHARS = 12_000;
const MAXIMUM_AGENT_REPLY_CHARS =
  BROWSER_AGENT_HISTORY_CHARS - BROWSER_AGENT_USER_MESSAGE_CHARS;
const MINIMUM_CMS_CONTENT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_CMS_FETCH_TIMEOUT_MS = 20_000;
const MAXIMUM_SHUTDOWN_TIMEOUT_MS = 18_000;
export const DEFAULT_AI_MODEL = 'deepseek-v4-flash';

function readBoundedInteger(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = environment[name]?.trim();
  if (!rawValue) return fallback;

  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsedValue;
}

function readEnvironment(environment: Environment): ServerEnvironment {
  const value = environment.NODE_ENV?.trim() || 'development';
  if (value === 'development' || value === 'production' || value === 'test') return value;
  throw new Error('NODE_ENV must be one of development, production, or test');
}

function readOrigin(environment: Environment, name: string, fallback: string): string {
  const rawValue = environment[name]?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${name} must be an absolute HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

export function loadServerConfig(
  environment: Environment = process.env,
  rootDirectory = process.cwd(),
): Readonly<ServerConfig> {
  const serverEnvironment = readEnvironment(environment);
  const maxMessageChars = readBoundedInteger(
    environment,
    'AGENT_MAX_MESSAGE_CHARS',
    4_000,
    200,
    MAXIMUM_AGENT_REPLY_CHARS,
  );
  const maxUserMessageChars = readBoundedInteger(
    environment,
    'AGENT_MAX_USER_MESSAGE_CHARS',
    BROWSER_AGENT_USER_MESSAGE_CHARS,
    BROWSER_AGENT_USER_MESSAGE_CHARS,
    8_000,
  );
  const maxHistoryChars = readBoundedInteger(
    environment,
    'AGENT_MAX_HISTORY_CHARS',
    BROWSER_AGENT_HISTORY_CHARS,
    BROWSER_AGENT_HISTORY_CHARS,
    64_000,
  );
  if (maxUserMessageChars > maxMessageChars) {
    throw new Error('AGENT_MAX_USER_MESSAGE_CHARS cannot exceed AGENT_MAX_MESSAGE_CHARS');
  }
  if (maxHistoryChars < maxUserMessageChars + maxMessageChars) {
    throw new Error(
      'AGENT_MAX_HISTORY_CHARS must fit one assistant message and the next user message',
    );
  }

  const apiKey = readOptionalSecret('AI_API_KEY', environment);
  const model = environment.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)) {
    throw new Error('AI_MODEL contains unsupported characters');
  }

  const cacheTtlMs = readBoundedInteger(
    environment,
    'CMS_CACHE_TTL_MS',
    30_000,
    0,
    5 * 60_000,
  );

  const agent = Object.freeze<AgentConfig>({
    apiKey,
    model,
    maxBodyBytes: readBoundedInteger(
      environment,
      'AGENT_MAX_BODY_BYTES',
      EDGE_AGENT_BODY_BYTES,
      EDGE_AGENT_BODY_BYTES,
      EDGE_AGENT_BODY_BYTES,
    ),
    maxMessages: readBoundedInteger(
      environment,
      'AGENT_MAX_MESSAGES',
      BROWSER_AGENT_MESSAGES,
      BROWSER_AGENT_MESSAGES,
      50,
    ),
    maxMessageChars,
    maxUserMessageChars,
    maxHistoryChars,
    maxOutputTokens: readBoundedInteger(environment, 'AGENT_MAX_OUTPUT_TOKENS', 512, 64, 2_048),
    upstreamTimeoutMs: readBoundedInteger(
      environment,
      'AGENT_UPSTREAM_TIMEOUT_MS',
      15_000,
      1_000,
      120_000,
    ),
    maxConcurrentRequests: readBoundedInteger(
      environment,
      'AGENT_MAX_CONCURRENT_REQUESTS',
      2,
      1,
      20,
    ),
    rateWindowMs: readBoundedInteger(
      environment,
      'AGENT_RATE_WINDOW_MS',
      60_000,
      1_000,
      60 * 60 * 1_000,
    ),
    rateRequestsPerWindow: readBoundedInteger(environment, 'AGENT_RATE_REQUESTS', 6, 1, 1_000),
    dailyRequestsPerIp: readBoundedInteger(
      environment,
      'AGENT_DAILY_REQUESTS_PER_IP',
      40,
      1,
      10_000,
    ),
    globalDailyRequests: readBoundedInteger(
      environment,
      'AGENT_GLOBAL_DAILY_REQUESTS',
      500,
      1,
      1_000_000,
    ),
    maxTrackedIps: readBoundedInteger(environment, 'AGENT_MAX_TRACKED_IPS', 10_000, 100, 100_000),
  });

  const publicSite = Object.freeze<PublicSiteConfig>({
    publicOrigin: readOrigin(
      environment,
      'PUBLIC_ORIGIN',
      serverEnvironment === 'production' ? 'https://beta-demo.top' : 'http://localhost:3000',
    ),
    cmsOrigin: readOrigin(
      environment,
      'CMS_INTERNAL_ORIGIN',
      serverEnvironment === 'production' ? 'http://backend:8000' : 'http://127.0.0.1:8000',
    ),
    fetchTimeoutMs: readBoundedInteger(
      environment,
      'CMS_FETCH_TIMEOUT_MS',
      3_000,
      250,
      MAXIMUM_CMS_FETCH_TIMEOUT_MS,
    ),
    contentLimitBytes: readBoundedInteger(
      environment,
      'CMS_CONTENT_LIMIT_BYTES',
      3 * 1024 * 1024,
      MINIMUM_CMS_CONTENT_BYTES,
      8 * 1024 * 1024,
    ),
    cacheTtlMs,
    staleTtlMs: readBoundedInteger(
      environment,
      'CMS_STALE_TTL_MS',
      5 * 60_000,
      cacheTtlMs,
      24 * 60 * 60_000,
    ),
  });

  const listener = Object.freeze<ListenerConfig>({
    host: '0.0.0.0',
    port: readBoundedInteger(environment, 'PORT', 3000, 1, 65_535),
    shutdownTimeoutMs: readBoundedInteger(
      environment,
      'SHUTDOWN_TIMEOUT_MS',
      18_000,
      1_000,
      MAXIMUM_SHUTDOWN_TIMEOUT_MS,
    ),
  });

  const trustProxyHops = readBoundedInteger(
    environment,
    'TRUST_PROXY_HOPS',
    serverEnvironment === 'production' ? 1 : 0,
    0,
    1,
  );
  if (serverEnvironment === 'production' && trustProxyHops !== 1) {
    throw new Error('TRUST_PROXY_HOPS must be 1 in the production Compose topology');
  }

  return Object.freeze({
    environment: serverEnvironment,
    rootDirectory,
    trustProxyHops,
    agent,
    publicSite,
    listener,
  });
}
