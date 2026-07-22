import type { Page, Route } from '@playwright/test';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import { blogPostPath, projectPath } from '../src/routing';

export const primaryPost = DEFAULT_SITE_CONTENT.blogPosts[0];
export const primaryPostPath = blogPostPath(primaryPost);
export const primaryProject = DEFAULT_SITE_CONTENT.projects[0];
export const primaryProjectPath = projectPath(primaryProject);

export interface AdminMockResponse {
  status?: number;
  body?: unknown;
  etag?: string;
  requestId?: string;
  delayMs?: number;
  waitFor?: Promise<void>;
}

export interface ObservedAdminSaveRequest {
  body: unknown;
  headers: Record<string, string>;
}

export interface AdminMockOptions {
  authenticated: boolean;
  loginStatus?: number;
  logoutStatus?: number;
  logoutResponse?: AdminMockResponse;
  contentResponses?: AdminMockResponse[];
  saveResponses?: AdminMockResponse[];
  mediaResponses?: AdminMockResponse[];
  mediaDeleteResponses?: AdminMockResponse[];
  revisionResponses?: AdminMockResponse[];
  revisionReadResponses?: AdminMockResponse[];
  onContentRequest?: () => void;
  onSaveRequest?: (request: ObservedAdminSaveRequest) => void;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function isAdminContentEnvelope(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'initialized' in value
    && 'content' in value;
}

export async function mockPublicContent(page: Page): Promise<void> {
  await page.route('**/backend/api/v1/content', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { ETag: '"e2e-public-content"' },
      body: jsonBody(DEFAULT_SITE_CONTENT),
    });
  });
}

export async function mockAdminApi(
  page: Page,
  options: AdminMockOptions,
): Promise<void> {
  let contentRequestIndex = 0;
  let saveRequestIndex = 0;
  let mediaRequestIndex = 0;
  let mediaDeleteRequestIndex = 0;
  let revisionRequestIndex = 0;
  let revisionReadRequestIndex = 0;

  const nextResponse = (
    responses: AdminMockResponse[] | undefined,
    index: number,
    fallback: AdminMockResponse,
  ) => responses?.[Math.min(index, responses.length - 1)] ?? fallback;

  const fulfillJson = async (
    route: Route,
    response: AdminMockResponse,
    fallbackBody: unknown,
  ) => {
    if (response.waitFor) await response.waitFor;
    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    const headers: Record<string, string> = {
      'X-Request-ID': response.requestId ?? 'e2e-admin-request',
    };
    if (response.etag) headers.ETag = response.etag;
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      headers,
      body: jsonBody(response.body ?? fallbackBody),
    });
  };

  await page.route('**/backend/api/v1/admin/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith('/admin/status')) {
      await route.fulfill({
        status: options.authenticated ? 200 : 401,
        contentType: 'application/json',
        headers: { 'X-Request-ID': 'e2e-admin-status' },
        body: jsonBody({ authenticated: options.authenticated }),
      });
      return;
    }

    if (url.pathname.endsWith('/admin/login')) {
      const status = options.loginStatus ?? 401;
      await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'X-Request-ID': 'e2e-admin-login' },
        body: jsonBody(status >= 200 && status < 300
          ? { authenticated: true }
          : { detail: 'Invalid administrator password' }),
      });
      return;
    }

    if (url.pathname.endsWith('/admin/logout')) {
      const response = options.logoutResponse ?? {
        status: options.logoutStatus ?? 200,
        requestId: 'e2e-admin-logout',
      };
      const status = response.status ?? 200;
      await fulfillJson(
        route,
        response,
        status >= 200 && status < 300
          ? { authenticated: false }
          : { detail: 'Unable to log out' },
      );
      return;
    }

    if (url.pathname.endsWith('/admin/content') && request.method() === 'GET') {
      options.onContentRequest?.();
      const response = nextResponse(
        options.contentResponses,
        contentRequestIndex,
        { body: DEFAULT_SITE_CONTENT, etag: '"e2e-admin-content"' },
      );
      contentRequestIndex += 1;
      const status = response.status ?? 200;
      const body = status >= 200 && status < 300
        ? isAdminContentEnvelope(response.body)
          ? response.body
          : { initialized: true, content: response.body ?? DEFAULT_SITE_CONTENT }
        : response.body;
      await fulfillJson(route, { ...response, body }, body);
      return;
    }

    if (url.pathname.endsWith('/admin/content') && request.method() === 'PUT') {
      let body: unknown = null;
      try {
        body = JSON.parse(request.postData() || 'null') as unknown;
      } catch {
        body = request.postData();
      }
      options.onSaveRequest?.({ body, headers: request.headers() });
      const response = nextResponse(
        options.saveResponses,
        saveRequestIndex,
        { body: { saved: true }, etag: '"e2e-admin-content-saved"' },
      );
      saveRequestIndex += 1;
      await fulfillJson(route, response, { saved: true });
      return;
    }

    if (url.pathname.endsWith('/admin/revisions') && request.method() === 'GET') {
      const response = nextResponse(
        options.revisionResponses,
        revisionRequestIndex,
        { body: { items: [], total: 0, limit: 30, offset: 0 } },
      );
      revisionRequestIndex += 1;
      await fulfillJson(route, response, { items: [], total: 0, limit: 30, offset: 0 });
      return;
    }

    if (/\/admin\/revisions\/\d+$/.test(url.pathname) && request.method() === 'GET') {
      const response = nextResponse(
        options.revisionReadResponses,
        revisionReadRequestIndex,
        { body: { payload: DEFAULT_SITE_CONTENT } },
      );
      revisionReadRequestIndex += 1;
      await fulfillJson(route, response, { payload: DEFAULT_SITE_CONTENT });
      return;
    }

    if (url.pathname.endsWith('/admin/media') && request.method() === 'GET') {
      const response = nextResponse(
        options.mediaResponses,
        mediaRequestIndex,
        { body: { items: [] } },
      );
      mediaRequestIndex += 1;
      await fulfillJson(route, response, { items: [] });
      return;
    }

    if (/\/admin\/media\/[^/]+$/.test(url.pathname) && request.method() === 'DELETE') {
      const response = nextResponse(
        options.mediaDeleteResponses,
        mediaDeleteRequestIndex,
        {
          body: {
            deleted: true,
            filename: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
          },
        },
      );
      mediaDeleteRequestIndex += 1;
      await fulfillJson(route, response, {
        deleted: true,
        filename: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: jsonBody({ detail: 'Unmocked admin E2E route' }),
    });
  });
}

export function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}
