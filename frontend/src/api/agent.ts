import { isAgentErrorCode, type AgentErrorCode } from './agentContract';

interface AgentErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export interface AgentHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_AGENT_HISTORY_MESSAGES = 12;
export const MAX_AGENT_HISTORY_CHARS = 12_000;
export const MAX_AGENT_USER_MESSAGE_CHARS = 1_500;

const agentErrorMessages: Partial<Record<AgentErrorCode, string>> = {
  UNSUPPORTED_MEDIA_TYPE: '请求格式不受支持，请刷新页面后重试。',
  INVALID_REQUEST: '对话内容格式无效，请重新输入。',
  DAILY_LIMIT_REACHED: '今天的对话次数已用完，请明天再试。',
  AI_DAILY_CAPACITY_REACHED: 'AI 服务今天的可用额度已用完，请明天再试。',
  AI_BUSY: 'AI 当前请求较多，请稍后重试。',
  AI_UPSTREAM_TIMEOUT: 'AI 响应超时，请稍后重试。',
  AI_EMPTY_RESPONSE: 'AI 没有返回有效内容，请稍后重试。',
  AI_UNAVAILABLE: 'AI 服务暂时不可用，请稍后重试。',
  PAYLOAD_TOO_LARGE: '对话内容过长，请缩短后重试。',
  INVALID_JSON: '请求内容无法解析，请刷新页面后重试。',
  INTERNAL_ERROR: 'AI 服务暂时不可用，请稍后重试。',
  API_NOT_FOUND: 'AI 服务接口暂时不可用，请稍后重试。',
};

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? null
    : Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
}

export async function agentErrorMessage(response: Response): Promise<string> {
  const payload = await response.clone().json().catch(() => null) as AgentErrorPayload | null;
  const code = payload?.error?.code;
  const retryAfter = retryAfterSeconds(response);

  if (code === 'RATE_LIMITED') {
    return retryAfter
      ? `请求过于频繁，请在 ${retryAfter} 秒后重试。`
      : '请求过于频繁，请稍后重试。';
  }
  if (isAgentErrorCode(code) && agentErrorMessages[code]) return agentErrorMessages[code];

  const serverMessage = typeof payload?.error?.message === 'string'
    ? payload.error.message.trim()
    : '';
  return serverMessage || `请求失败（HTTP ${response.status}），请稍后重试。`;
}

export function agentReply(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

export function boundedAgentHistory(
  messages: readonly AgentHistoryMessage[],
): AgentHistoryMessage[] {
  const selected: AgentHistoryMessage[] = [];
  let selectedChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_AGENT_HISTORY_MESSAGES) break;

    const message = messages[index];
    const content = message.content.trim();
    if (!content) continue;
    if (selectedChars + content.length > MAX_AGENT_HISTORY_CHARS) break;

    selected.unshift({ role: message.role, content });
    selectedChars += content.length;
  }

  return selected;
}
