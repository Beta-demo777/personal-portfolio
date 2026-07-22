import { createHash } from 'node:crypto';
import {
  DEFAULT_SITE_CONTENT,
  normalizeSiteContent,
  type SiteContent,
  type SiteContentStatus,
} from '../src/content';
import { BOOTSTRAP_ELEMENT_ID, serializePublicBootstrap } from '../src/bootstrap';
import { isSiteContent } from '../src/contentValidation';
import {
  buildPublicHead,
  PUBLIC_JSON_LD_ID,
  ROBOTS_LOCK_ATTRIBUTE,
  resolvePublicRoute,
  type ResolvedPublicRoute,
} from '../src/publicHead';
import { blogPostPath, projectPath } from '../src/routing';
import { renderPublicApplication } from '../src/entry-server';

export { resolvePublicRoute } from '../src/publicHead';

const DEFAULT_CONTENT_LIMIT_BYTES = 3 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_STALE_TTL_MS = 5 * 60_000;

type PublicContentStatus = Exclude<SiteContentStatus, 'loading'>;

export interface PublicContentSnapshot {
  content: SiteContent;
  status: PublicContentStatus;
}

interface CachedContent {
  content: SiteContent;
  etag?: string;
  fetchedAt: number;
}

interface PublicSiteRendererOptions {
  template: string;
  publicOrigin: string;
  cmsOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
  contentLimitBytes?: number;
  cacheTtlMs?: number;
  staleTtlMs?: number;
}

export interface RenderedPublicPage {
  body: string;
  statusCode: 200 | 404 | 503;
  redirectPath?: string;
}

export interface RenderedPublicResource {
  body: string;
  statusCode: 200 | 503;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderHead(route: ResolvedPublicRoute, content: SiteContent, publicOrigin: string): string {
  const metadata = buildPublicHead(route, content, publicOrigin);
  const robotsLock = metadata.robotsLocked
    ? ` ${ROBOTS_LOCK_ATTRIBUTE}="unavailable"`
    : '';
  const imageTags = metadata.imageUrl
    ? `\n    <meta property="og:image" content="${escapeHtml(metadata.imageUrl)}" />\n    <meta name="twitter:image" content="${escapeHtml(metadata.imageUrl)}" />`
    : '';
  return `
    <meta name="description" content="${escapeHtml(metadata.description)}" />
    <meta name="theme-color" content="#050507" />
    <meta name="color-scheme" content="dark" />
    <meta name="robots" content="${metadata.robots}"${robotsLock} />
    <link rel="canonical" href="${escapeHtml(metadata.canonicalUrl)}" />
    <link rel="manifest" href="/site.webmanifest" />
    <link rel="alternate" type="application/rss+xml" title="${escapeHtml(content.siteSettings.siteTitle)} RSS" href="/rss.xml" />
    <meta property="og:type" content="${metadata.openGraphType}" />
    <meta property="og:locale" content="zh_CN" />
    <meta property="og:site_name" content="${escapeHtml(metadata.siteName)}" />
    <meta property="og:title" content="${escapeHtml(metadata.title)}" />
    <meta property="og:description" content="${escapeHtml(metadata.description)}" />
    <meta property="og:url" content="${escapeHtml(metadata.canonicalUrl)}" />${imageTags}
    <meta name="twitter:card" content="${metadata.twitterCard}" />
    <meta name="twitter:title" content="${escapeHtml(metadata.title)}" />
    <meta name="twitter:description" content="${escapeHtml(metadata.description)}" />
    <meta name="twitter:url" content="${escapeHtml(metadata.canonicalUrl)}" />
    <meta name="twitter:type" content="${metadata.openGraphType}" />
    <script type="application/ld+json" id="${PUBLIC_JSON_LD_ID}">${safeJson(metadata.jsonLd)}</script>
    <title>${escapeHtml(metadata.title)}</title>`;
}

export function injectDocument(
  template: string,
  head: string,
  applicationHtml: string,
  bootstrap: string,
): string {
  const headStart = '<!--portfolio-default-head-start-->';
  const headEnd = '<!--portfolio-default-head-end-->';
  const startIndex = template.indexOf(headStart);
  const endIndex = template.indexOf(headEnd);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error('Frontend template is missing the SSR head markers');
  }
  const withHead = `${template.slice(0, startIndex)}${head}${template.slice(endIndex + headEnd.length)}`;
  if (!withHead.includes('<!--portfolio-app-->') || !withHead.includes('<!--portfolio-bootstrap-->')) {
    throw new Error('Frontend template is missing the SSR body markers');
  }
  return withHead
    .replace('<!--portfolio-app-->', applicationHtml)
    .replace(
      '<!--portfolio-bootstrap-->',
      `<template id="${BOOTSTRAP_ELEMENT_ID}">${bootstrap}</template>`,
    );
}

async function boundedJson(response: Response, limitBytes: number): Promise<unknown> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new Error('CMS response must use application/json');

  const declaredLengthHeader = response.headers.get('content-length');
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null) {
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new Error('CMS response has an invalid Content-Length');
    }
    if (declaredLength > limitBytes) {
      throw new Error('CMS response exceeds the configured size limit');
    }
  }
  if (!response.body) throw new Error('CMS response has no body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel('CMS response exceeds the configured size limit');
        throw new Error('CMS response exceeds the configured size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export class PublicSiteRenderer {
  private readonly template: string;
  private readonly publicOrigin: string;
  private readonly cmsOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private readonly contentLimitBytes: number;
  private readonly cacheTtlMs: number;
  private readonly staleTtlMs: number;
  private cachedContent: CachedContent | null = null;
  private pendingContent: Promise<PublicContentSnapshot> | null = null;

  constructor(options: PublicSiteRendererOptions) {
    this.template = options.template;
    this.publicOrigin = options.publicOrigin.replace(/\/$/, '');
    this.cmsOrigin = options.cmsOrigin.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.contentLimitBytes = options.contentLimitBytes ?? DEFAULT_CONTENT_LIMIT_BYTES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  }

  async loadContent(): Promise<PublicContentSnapshot> {
    const now = this.now();
    if (this.cachedContent && now - this.cachedContent.fetchedAt <= this.cacheTtlMs) {
      return { content: this.cachedContent.content, status: 'ready' };
    }

    if (this.pendingContent) return this.pendingContent;
    this.pendingContent = this.fetchContent(now).finally(() => {
      this.pendingContent = null;
    });
    return this.pendingContent;
  }

  private async fetchContent(now: number): Promise<PublicContentSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchImpl(`${this.cmsOrigin}/api/v1/content`, {
        signal: controller.signal,
        headers: this.cachedContent?.etag ? { 'If-None-Match': this.cachedContent.etag } : undefined,
      });
      if (response.status === 304 && this.cachedContent) {
        this.cachedContent.fetchedAt = now;
        return { content: this.cachedContent.content, status: 'ready' };
      }
      if (!response.ok) throw new Error(`CMS request failed with HTTP ${response.status}`);
      const payload = await boundedJson(response, this.contentLimitBytes);
      if (typeof payload === 'object'
        && payload !== null
        && !Array.isArray(payload)
        && Object.keys(payload).length === 0) {
        return { content: DEFAULT_SITE_CONTENT, status: 'unavailable' };
      }
      if (!isSiteContent(payload)) throw new Error('CMS response does not match the public content contract');
      const content = normalizeSiteContent(payload);
      this.cachedContent = {
        content,
        etag: response.headers.get('etag') || undefined,
        fetchedAt: now,
      };
      return { content, status: 'ready' };
    } catch {
      if (this.cachedContent && now - this.cachedContent.fetchedAt <= this.staleTtlMs) {
        return { content: this.cachedContent.content, status: 'stale' };
      }
      return { content: DEFAULT_SITE_CONTENT, status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async render(requestUrl: string): Promise<RenderedPublicPage> {
    const snapshot = await this.loadContent();
    const route = resolvePublicRoute(requestUrl, snapshot.content, snapshot.status, this.publicOrigin);
    if (route.redirectPath) {
      return { body: '', statusCode: route.statusCode, redirectPath: route.redirectPath };
    }
    const renderYear = new Date(this.now()).getUTCFullYear();
    const applicationHtml = await renderPublicApplication({
      url: requestUrl,
      content: snapshot.content,
      status: snapshot.status,
      renderYear,
    });
    const head = renderHead(route, snapshot.content, this.publicOrigin);
    const bootstrap = serializePublicBootstrap({
      content: snapshot.content,
      status: snapshot.status,
      renderYear,
    });
    return {
      body: injectDocument(this.template, head, applicationHtml, bootstrap),
      statusCode: route.statusCode,
    };
  }

  async sitemap(): Promise<RenderedPublicResource> {
    const { content, status } = await this.loadContent();
    const paths = [
      '/',
      '/portfolio',
      ...content.projects.map(projectPath),
      '/blog',
      ...content.blogPosts.map(blogPostPath),
      '/agent',
      '/about',
    ];
    const entries = [...new Set(paths)].map((path) => (
      `  <url><loc>${escapeXml(new URL(path, this.publicOrigin).toString())}</loc></url>`
    ));
    return {
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`,
      statusCode: status === 'unavailable' ? 503 : 200,
    };
  }

  async rss(): Promise<RenderedPublicResource> {
    const { content, status } = await this.loadContent();
    const items = [...content.blogPosts]
      .sort((left, right) => right.date.localeCompare(left.date))
      .map((post) => {
        const link = new URL(blogPostPath(post), this.publicOrigin).toString();
        const published = new Date(`${post.date}T00:00:00Z`).toUTCString();
        return `    <item>\n      <title>${escapeXml(post.title)}</title>\n      <link>${escapeXml(link)}</link>\n      <guid isPermaLink="true">${escapeXml(link)}</guid>\n      <pubDate>${published}</pubDate>\n      <description>${escapeXml(post.excerpt)}</description>\n    </item>`;
      });
    const channelUrl = new URL('/blog', this.publicOrigin).toString();
    return {
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${escapeXml(content.siteSettings.siteTitle)}</title>\n    <link>${escapeXml(channelUrl)}</link>\n    <description>${escapeXml(content.siteSettings.siteDescription)}</description>\n${items.join('\n')}\n  </channel>\n</rss>\n`,
      statusCode: status === 'unavailable' ? 503 : 200,
    };
  }

  static etag(body: string): string {
    return `"${createHash('sha256').update(body).digest('base64url')}"`;
  }
}
