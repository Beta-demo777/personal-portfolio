export const AGENT_ERROR_CODES = [
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_REQUEST',
  'RATE_LIMITED',
  'DAILY_LIMIT_REACHED',
  'AI_DAILY_CAPACITY_REACHED',
  'AI_BUSY',
  'AI_EMPTY_RESPONSE',
  'AI_UPSTREAM_TIMEOUT',
  'AI_UNAVAILABLE',
  'PAYLOAD_TOO_LARGE',
  'INVALID_JSON',
  'INTERNAL_ERROR',
  'API_NOT_FOUND',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

const agentErrorCodeSet = new Set<string>(AGENT_ERROR_CODES);

export function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return typeof value === 'string' && agentErrorCodeSet.has(value);
}
