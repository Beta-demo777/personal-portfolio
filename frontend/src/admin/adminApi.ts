import type { SiteContent } from '../content';
import { isSiteContent } from '../contentValidation';

export type AdminApiErrorKind =
  | 'aborted'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'validation'
  | 'rate-limited'
  | 'server'
  | 'http'
  | 'invalid-response'
  | 'network';

export const ADMIN_API_ERROR_CODES = {
  contentVersionConflict: 'CONTENT_VERSION_CONFLICT',
  mediaReferenceMissing: 'MEDIA_REFERENCE_MISSING',
  mediaStillReferenced: 'MEDIA_STILL_REFERENCED',
  revisionIncompatible: 'REVISION_INCOMPATIBLE',
} as const;

export type AdminApiErrorCode = typeof ADMIN_API_ERROR_CODES[keyof typeof ADMIN_API_ERROR_CODES];
export type AdminApiErrorDetails = Readonly<Record<string, unknown>>;

export interface AdminMediaItem {
  filename: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  referenced: boolean;
  references: string[];
}

export interface AdminRevisionSummary {
  id: number;
  createdAt: string;
  reason?: string;
  summary?: {
    posts: number;
    drafts: number;
    projects: number;
    skillGroups: number;
    sizeBytes: number;
  };
}

export type AdminContentResponse =
  | { initialized: false; content: null; etag: string }
  | { initialized: true; content: SiteContent; etag: string };

type AdminContentEnvelope =
  | { initialized: false; content: null }
  | { initialized: true; content: SiteContent };

interface JsonResult<T> {
  value: T;
  response: Response;
}

type Decoder<T> = (value: unknown) => T;
type ErrorMessageOverrides = Partial<Record<AdminApiErrorKind, string>>;

export class AdminApiError extends Error {
  readonly kind: AdminApiErrorKind;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly detail: string | null;
  readonly code: string | null;
  readonly details: AdminApiErrorDetails | null;

  constructor({
    kind,
    message,
    status = null,
    requestId = null,
    retryAfterSeconds = null,
    detail = null,
    code = null,
    details = null,
  }: {
    kind: AdminApiErrorKind;
    message: string;
    status?: number | null;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
    detail?: string | null;
    code?: string | null;
    details?: AdminApiErrorDetails | null;
  }) {
    super(message);
    this.name = 'AdminApiError';
    this.kind = kind;
    this.status = status;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function decodeBooleanField(value: unknown, field: string): boolean {
  if (!isRecord(value) || typeof value[field] !== 'boolean') {
    throw new Error(`Expected boolean field ${field}`);
  }
  return value[field];
}

function decodeSaved(value: unknown): true {
  if (!isRecord(value) || value.saved !== true) throw new Error('Expected saved response');
  return true;
}

function decodeDeleted(value: unknown): true {
  if (!isRecord(value) || value.deleted !== true || typeof value.filename !== 'string') {
    throw new Error('Expected deleted media response');
  }
  return true;
}

function decodeCompleteContent(value: unknown): SiteContent {
  if (!isSiteContent(value)) throw new Error('Expected complete site content');
  return value;
}

function decodeAdminContent(value: unknown): AdminContentEnvelope {
  if (!isRecord(value) || typeof value.initialized !== 'boolean') {
    throw new Error('Expected administrator content envelope');
  }
  if (value.initialized === false) {
    if (value.content !== null) throw new Error('Expected null content before initialization');
    return { initialized: false, content: null };
  }
  return { initialized: true, content: decodeCompleteContent(value.content) };
}

function decodeUploadedMedia(value: unknown): Omit<AdminMediaItem, 'referenced' | 'references'> {
  if (!isRecord(value)
    || typeof value.filename !== 'string'
    || typeof value.url !== 'string'
    || typeof value.contentType !== 'string'
    || !isNonNegativeInteger(value.sizeBytes)
    || !isDateString(value.uploadedAt)) {
    throw new Error('Expected uploaded media metadata');
  }
  return {
    filename: value.filename,
    url: value.url,
    contentType: value.contentType,
    sizeBytes: value.sizeBytes,
    uploadedAt: value.uploadedAt,
  };
}

function decodeMediaItem(value: unknown): AdminMediaItem {
  const uploaded = decodeUploadedMedia(value);
  if (!isRecord(value)
    || typeof value.referenced !== 'boolean'
    || !Array.isArray(value.references)
    || !value.references.every((reference) => typeof reference === 'string')) {
    throw new Error('Expected media reference metadata');
  }
  return {
    ...uploaded,
    referenced: value.referenced,
    references: value.references,
  };
}

function decodeMediaList(value: unknown): AdminMediaItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('Expected media list');
  if (value.total !== undefined && !isNonNegativeInteger(value.total)) throw new Error('Expected media total');
  return value.items.map(decodeMediaItem);
}

function decodeRevisionSummary(value: unknown): AdminRevisionSummary {
  if (!isRecord(value) || !isNonNegativeInteger(value.id) || !isDateString(value.createdAt)) {
    throw new Error('Expected revision metadata');
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('Expected revision reason');
  let summary: AdminRevisionSummary['summary'];
  if (value.summary !== undefined) {
    if (!isRecord(value.summary)
      || !isNonNegativeInteger(value.summary.posts)
      || !isNonNegativeInteger(value.summary.drafts)
      || !isNonNegativeInteger(value.summary.projects)
      || !isNonNegativeInteger(value.summary.skillGroups)
      || !isNonNegativeInteger(value.summary.sizeBytes)) {
      throw new Error('Expected revision summary');
    }
    summary = {
      posts: value.summary.posts,
      drafts: value.summary.drafts,
      projects: value.summary.projects,
      skillGroups: value.summary.skillGroups,
      sizeBytes: value.summary.sizeBytes,
    };
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function decodeRevisionList(value: unknown): AdminRevisionSummary[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('Expected revision list');
  for (const field of ['total', 'limit', 'offset'] as const) {
    if (value[field] !== undefined && !isNonNegativeInteger(value[field])) {
      throw new Error(`Expected revision ${field}`);
    }
  }
  return value.items.map(decodeRevisionSummary);
}

function decodeRevisionContent(value: unknown): SiteContent {
  if (!isRecord(value) || value.payload === undefined) throw new Error('Expected revision payload');
  return decodeCompleteContent(value.payload);
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
}

interface ParsedErrorBody {
  code: string | null;
  detail: string | null;
  details: AdminApiErrorDetails | null;
}

function structuredErrorDetail(value: unknown): ParsedErrorBody | null {
  if (!isRecord(value) || !isRecord(value.detail)) return null;
  const { code, message, details } = value.detail;
  if (typeof code !== 'string'
    || code.trim().length === 0
    || typeof message !== 'string'
    || message.trim().length === 0
    || (details !== undefined && !isRecord(details))) {
    return null;
  }
  return {
    code,
    detail: message,
    details: details ?? null,
  };
}

function legacyErrorDetail(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.detail === 'string') return value.detail;
  if (isRecord(value.detail) && typeof value.detail.message === 'string') return value.detail.message;
  if (Array.isArray(value.detail)) {
    const messages = value.detail.flatMap((item) => (
      isRecord(item) && typeof item.msg === 'string' ? [item.msg] : []
    ));
    return messages.length > 0 ? messages.slice(0, 3).join('；') : null;
  }
  return null;
}

function parseErrorBody(value: unknown): ParsedErrorBody {
  return structuredErrorDetail(value) ?? {
    code: null,
    detail: legacyErrorDetail(value),
    details: null,
  };
}

function kindForStatus(status: number, code: string | null): AdminApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409 && code === ADMIN_API_ERROR_CODES.contentVersionConflict) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'http';
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return null;
  }
}

async function requestJson<T>(path: string, init: RequestInit, decode: Decoder<T>): Promise<JsonResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'include' });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    throw new AdminApiError({
      kind: aborted ? 'aborted' : 'network',
      message: aborted ? 'Admin request was cancelled' : 'Admin API is unreachable',
    });
  }

  const requestId = response.headers.get('x-request-id')?.trim() || null;
  if (!response.ok) {
    const body = await readErrorBody(response);
    const { code, detail, details } = parseErrorBody(body);
    throw new AdminApiError({
      kind: kindForStatus(response.status, code),
      message: detail || `Admin API returned HTTP ${response.status}`,
      status: response.status,
      requestId,
      retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
      detail,
      code,
      details,
    });
  }

  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    throw new AdminApiError({
      kind: 'invalid-response',
      message: 'Admin API returned invalid JSON',
      status: response.status,
      requestId,
    });
  }
  try {
    return { value: decode(body), response };
  } catch {
    throw new AdminApiError({
      kind: 'invalid-response',
      message: 'Admin API response did not match its contract',
      status: response.status,
      requestId,
    });
  }
}

function withRequestId(message: string, requestId: string | null): string {
  return requestId ? `${message}（请求编号：${requestId}）` : message;
}

function requiredEtag(response: Response): string {
  const etag = response.headers.get('etag')?.trim();
  if (etag) return etag;
  throw new AdminApiError({
    kind: 'invalid-response',
    message: 'Admin API response did not include an ETag',
    status: response.status,
    requestId: response.headers.get('x-request-id')?.trim() || null,
  });
}

export function describeAdminApiError(
  error: unknown,
  fallback: string,
  overrides: ErrorMessageOverrides = {},
): string {
  if (!(error instanceof AdminApiError)) return error instanceof Error ? error.message : fallback;
  const defaults: Record<AdminApiErrorKind, string> = {
    aborted: '请求已取消',
    unauthorized: '登录会话已失效，请重新登录',
    forbidden: '当前请求被后台拒绝，请刷新页面后重试',
    conflict: '服务器内容已发生变化，请先合并最新版本',
    validation: '提交内容未通过后台校验，请检查字段后重试',
    'rate-limited': `请求过于频繁${error.retryAfterSeconds ? `，请在 ${error.retryAfterSeconds} 秒后重试` : '，请稍后重试'}`,
    server: `${fallback}${error.status ? `（HTTP ${error.status}）` : ''}`,
    http: `${fallback}${error.status ? `（HTTP ${error.status}）` : ''}`,
    'invalid-response': `${fallback}：后台返回的数据格式不正确`,
    network: `${fallback}：无法连接后台服务`,
  };
  return withRequestId(overrides[error.kind] ?? defaults[error.kind], error.requestId);
}

export function isAdminApiError(error: unknown, kind?: AdminApiErrorKind): error is AdminApiError {
  return error instanceof AdminApiError && (kind === undefined || error.kind === kind);
}

export function isAdminApiErrorCode<Code extends string>(
  error: unknown,
  code: Code,
): error is AdminApiError & { readonly code: Code } {
  return error instanceof AdminApiError && error.status === 409 && error.code === code;
}

export const adminApi = {
  async status(signal?: AbortSignal): Promise<boolean> {
    const result = await requestJson(
      '/backend/api/v1/admin/status',
      { method: 'GET', signal },
      (value) => decodeBooleanField(value, 'authenticated'),
    );
    return result.value;
  },

  async login(password: string, signal?: AbortSignal): Promise<boolean> {
    const result = await requestJson(
      '/backend/api/v1/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        signal,
      },
      (value) => decodeBooleanField(value, 'authenticated'),
    );
    return result.value;
  },

  async logout(signal?: AbortSignal): Promise<boolean> {
    const result = await requestJson(
      '/backend/api/v1/admin/logout',
      { method: 'POST', signal },
      (value) => decodeBooleanField(value, 'authenticated'),
    );
    return result.value;
  },

  async readContent(signal?: AbortSignal): Promise<AdminContentResponse> {
    const result = await requestJson(
      '/backend/api/v1/admin/content',
      { method: 'GET', signal },
      decodeAdminContent,
    );
    return { ...result.value, etag: requiredEtag(result.response) };
  },

  async saveContent(content: SiteContent, etag: string | null, signal?: AbortSignal): Promise<string> {
    if (!isSiteContent(content)) {
      throw new AdminApiError({ kind: 'validation', message: 'Local content failed validation' });
    }
    if (!etag?.trim()) {
      throw new AdminApiError({
        kind: 'invalid-response',
        message: 'Cannot save without a confirmed content ETag',
      });
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    const result = await requestJson(
      '/backend/api/v1/admin/content',
      { method: 'PUT', headers, body: JSON.stringify(content), signal },
      decodeSaved,
    );
    return requiredEtag(result.response);
  },

  async listMedia(signal?: AbortSignal): Promise<AdminMediaItem[]> {
    const result = await requestJson(
      '/backend/api/v1/admin/media',
      { method: 'GET', signal },
      decodeMediaList,
    );
    return result.value;
  },

  async uploadMedia(file: File, signal?: AbortSignal): Promise<Omit<AdminMediaItem, 'referenced' | 'references'>> {
    const form = new FormData();
    form.append('image', file);
    const result = await requestJson(
      '/backend/api/v1/admin/uploads',
      { method: 'POST', body: form, signal },
      decodeUploadedMedia,
    );
    return result.value;
  },

  async deleteMedia(filename: string, signal?: AbortSignal): Promise<void> {
    await requestJson(
      `/backend/api/v1/admin/media/${encodeURIComponent(filename)}`,
      { method: 'DELETE', signal },
      decodeDeleted,
    );
  },

  async listRevisions(signal?: AbortSignal): Promise<AdminRevisionSummary[]> {
    const result = await requestJson(
      '/backend/api/v1/admin/revisions?limit=30',
      { method: 'GET', signal },
      decodeRevisionList,
    );
    return result.value;
  },

  async readRevision(id: number, signal?: AbortSignal): Promise<SiteContent> {
    const result = await requestJson(
      `/backend/api/v1/admin/revisions/${id}`,
      { method: 'GET', signal },
      decodeRevisionContent,
    );
    return result.value;
  },
};
