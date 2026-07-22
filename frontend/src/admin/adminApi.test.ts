import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_CONTENT } from '../content';
import {
  ADMIN_API_ERROR_CODES,
  adminApi,
  describeAdminApiError,
  isAdminApiError,
  isAdminApiErrorCode,
} from './adminApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adminApi', () => {
  it('decodes valid content and exposes its ETag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      initialized: true,
      content: DEFAULT_SITE_CONTENT,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"content-v4"' },
    })));

    const result = await adminApi.readContent();

    expect(result.initialized).toBe(true);
    expect(result.content?.siteSettings.siteTitle).toBe(DEFAULT_SITE_CONTENT.siteSettings.siteTitle);
    expect(result.etag).toBe('"content-v4"');
  });

  it('represents an uninitialized content store without substituting defaults', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      initialized: false,
      content: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"content-empty"' },
    })));

    await expect(adminApi.readContent()).resolves.toEqual({
      initialized: false,
      content: null,
      etag: '"content-empty"',
    });
  });

  it('rejects partial content instead of filling missing sections with defaults', async () => {
    const partialContent = {
      siteSettings: DEFAULT_SITE_CONTENT.siteSettings,
      blogPosts: DEFAULT_SITE_CONTENT.blogPosts,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      initialized: true,
      content: partialContent,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: '"content-partial"',
        'X-Request-ID': 'req-partial-content',
      },
    })));

    const error = await adminApi.readContent().catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'invalid-response')).toBe(true);
    expect(describeAdminApiError(error, '无法读取内容')).toContain('req-partial-content');
  });

  it('rejects malformed success payloads instead of trusting a type assertion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ filename: 42 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req-invalid-media' },
    })));

    const error = await adminApi.listMedia().catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'invalid-response')).toBe(true);
    expect(describeAdminApiError(error, '无法读取媒体资源')).toContain('req-invalid-media');
  });

  it('requires an ETag on validated content responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      initialized: true,
      content: DEFAULT_SITE_CONTENT,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req-missing-etag' },
    })));

    const error = await adminApi.readContent().catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'invalid-response')).toBe(true);
    expect(describeAdminApiError(error, '无法读取内容')).toContain('req-missing-etag');
  });

  it('normalizes status errors and preserves retry and request identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Too many attempts' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '12',
        'X-Request-ID': 'req-rate-limit',
      },
    })));

    const error = await adminApi.login('wrong-password').catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'rate-limited')).toBe(true);
    expect(describeAdminApiError(error, '登录失败')).toBe('请求过于频繁，请在 12 秒后重试（请求编号：req-rate-limit）');
  });

  it('marks only a structured content version error as a save conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: ADMIN_API_ERROR_CODES.contentVersionConflict,
        message: 'Content changed in another session. Reload before publishing.',
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req-content-conflict' },
    })));

    const error = await adminApi.saveContent(DEFAULT_SITE_CONTENT, '"content-v1"')
      .catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'conflict')).toBe(true);
    expect(isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.contentVersionConflict)).toBe(true);
    if (!isAdminApiError(error)) throw new Error('Expected AdminApiError');
    expect(error.code).toBe('CONTENT_VERSION_CONFLICT');
    expect(error.detail).toBe('Content changed in another session. Reload before publishing.');
    expect(error.details).toBeNull();
    expect(error.requestId).toBe('req-content-conflict');
  });

  it('preserves missing media details without treating the response as a version conflict', async () => {
    const filenames = ['missing-cover.webp', 'missing-inline.png'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: ADMIN_API_ERROR_CODES.mediaReferenceMissing,
        message: 'Content references unavailable managed media',
        details: { filenames },
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    const error = await adminApi.saveContent(DEFAULT_SITE_CONTENT, '"content-v1"')
      .catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'conflict')).toBe(false);
    expect(isAdminApiError(error, 'http')).toBe(true);
    expect(isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.mediaReferenceMissing)).toBe(true);
    if (!isAdminApiError(error)) throw new Error('Expected AdminApiError');
    expect(error.details).toEqual({ filenames });
  });

  it('preserves referenced-media paths as a separately identifiable deletion failure', async () => {
    const references = ['$.blogPosts[0].coverImage'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: ADMIN_API_ERROR_CODES.mediaStillReferenced,
        message: 'Media file is still referenced by site content',
        details: { references },
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    const error = await adminApi.deleteMedia('used-cover.png').catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'conflict')).toBe(false);
    expect(isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.mediaStillReferenced)).toBe(true);
    if (!isAdminApiError(error)) throw new Error('Expected AdminApiError');
    expect(error.details).toEqual({ references });
  });

  it('does not trust an incomplete structured error contract as a version conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: ADMIN_API_ERROR_CODES.contentVersionConflict,
        message: 'Content changed',
        details: ['not-an-object'],
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })));

    const error = await adminApi.status().catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'http')).toBe(true);
    expect(isAdminApiError(error, 'conflict')).toBe(false);
    if (!isAdminApiError(error)) throw new Error('Expected AdminApiError');
    expect(error.code).toBeNull();
    expect(error.detail).toBe('Content changed');
    expect(error.details).toBeNull();
  });

  it('does not treat a stable 409 code on an unrelated HTTP status as that contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: ADMIN_API_ERROR_CODES.mediaReferenceMissing,
        message: 'Unexpected upstream failure',
        details: { filenames: ['missing.png'] },
      },
    }), { status: 500, headers: { 'Content-Type': 'application/json' } })));

    const error = await adminApi.saveContent(DEFAULT_SITE_CONTENT, '"content-v1"')
      .catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'server')).toBe(true);
    expect(isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.mediaReferenceMissing)).toBe(false);
    if (!isAdminApiError(error)) throw new Error('Expected AdminApiError');
    expect(error.code).toBe(ADMIN_API_ERROR_CODES.mediaReferenceMissing);
  });

  it('preserves a revision incompatibility response as a stable non-version conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: ADMIN_API_ERROR_CODES.revisionIncompatible,
        message: 'This revision does not match the current content schema',
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })));

    const error = await adminApi.readRevision(7).catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'http')).toBe(true);
    expect(isAdminApiError(error, 'conflict')).toBe(false);
    expect(isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.revisionIncompatible)).toBe(true);
  });

  it('validates local content before issuing a save request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const invalid = structuredClone(DEFAULT_SITE_CONTENT) as typeof DEFAULT_SITE_CONTENT;
    invalid.blogPosts[0].date = '2026-02-30';

    const error = await adminApi.saveContent(invalid, '"content-v1"').catch((caught: unknown) => caught);

    expect(isAdminApiError(error, 'validation')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [409, 'http'],
    [422, 'validation'],
    [500, 'server'],
  ] as const)('maps HTTP %s to the %s failure kind', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'safe error' }), {
      status,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': `req-${status}` },
    })));

    const error = await adminApi.status().catch((caught: unknown) => caught);

    expect(isAdminApiError(error, kind)).toBe(true);
    expect(describeAdminApiError(error, '请求失败')).toContain(`req-${status}`);
  });
});
