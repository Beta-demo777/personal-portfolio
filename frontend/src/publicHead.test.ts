import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SITE_CONTENT } from './content';
import {
  applyPublicHead,
  buildPublicHead,
  PUBLIC_JSON_LD_ID,
  ROBOTS_LOCK_ATTRIBUTE,
  resolvePublicRoute,
} from './publicHead';
import { blogPostPath } from './routing';

const ORIGIN = 'https://portfolio.test';

function meta(selector: string): string | null {
  return document.head.querySelector<HTMLMetaElement>(selector)?.content ?? null;
}

describe('public route head model', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="robots" content="index, follow"><title>fallback</title>';
  });

  it('builds and applies complete article metadata, then removes article-only state', () => {
    const post = {
      ...DEFAULT_SITE_CONTENT.blogPosts[0],
      slug: 'shared-head-contract',
      seoTitle: 'Shared head contract',
      seoDescription: 'One model for SSR and browser navigation.',
      coverImage: '/backend/uploads/cover.png',
    };
    const content = {
      ...DEFAULT_SITE_CONTENT,
      blogPosts: [post, ...DEFAULT_SITE_CONTENT.blogPosts.slice(1)],
    };
    const articleRoute = resolvePublicRoute(blogPostPath(post), content, 'ready', ORIGIN);
    const articleHead = buildPublicHead(articleRoute, content, ORIGIN);

    applyPublicHead(document, articleHead);

    expect(document.title).toBe(post.seoTitle);
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href)
      .toBe(`${ORIGIN}${blogPostPath(post)}`);
    expect(meta('meta[property="og:type"]')).toBe('article');
    expect(meta('meta[property="og:image"]')).toBe(`${ORIGIN}${post.coverImage}`);
    expect(meta('meta[name="twitter:image"]')).toBe(`${ORIGIN}${post.coverImage}`);
    expect(meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(meta('meta[name="twitter:url"]')).toBe(`${ORIGIN}${blogPostPath(post)}`);
    expect(meta('meta[name="twitter:type"]')).toBe('article');

    const articleJsonLd = JSON.parse(document.getElementById(PUBLIC_JSON_LD_ID)?.textContent || '{}');
    expect(articleJsonLd['@graph']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        '@type': 'BlogPosting',
        headline: post.seoTitle,
        datePublished: post.date,
        image: `${ORIGIN}${post.coverImage}`,
      }),
    ]));

    const listRoute = resolvePublicRoute('/blog', content, 'ready', ORIGIN);
    applyPublicHead(document, buildPublicHead(listRoute, content, ORIGIN));

    expect(meta('meta[property="og:type"]')).toBe('website');
    expect(meta('meta[property="og:image"]')).toBeNull();
    expect(meta('meta[name="twitter:image"]')).toBeNull();
    expect(meta('meta[name="twitter:card"]')).toBe('summary');
    const listJsonLd = JSON.parse(document.getElementById(PUBLIC_JSON_LD_ID)?.textContent || '{}');
    expect(listJsonLd['@graph']).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ '@type': 'BlogPosting' }),
    ]));
  });

  it('never releases a noindex lock established by an unavailable SSR response', () => {
    const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')!;
    robots.content = 'noindex, nofollow';
    robots.setAttribute(ROBOTS_LOCK_ATTRIBUTE, 'unavailable');

    const readyRoute = resolvePublicRoute('/blog', DEFAULT_SITE_CONTENT, 'ready', ORIGIN);
    applyPublicHead(document, buildPublicHead(readyRoute, DEFAULT_SITE_CONTENT, ORIGIN));

    expect(robots.content).toBe('noindex, nofollow');
    expect(robots.getAttribute(ROBOTS_LOCK_ATTRIBUTE)).toBe('unavailable');
  });

  it('locks noindex when the browser discovers CMS unavailability', () => {
    const unavailable = resolvePublicRoute('/', DEFAULT_SITE_CONTENT, 'unavailable', ORIGIN);
    applyPublicHead(document, buildPublicHead(unavailable, DEFAULT_SITE_CONTENT, ORIGIN));
    const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')!;

    expect(robots.content).toBe('noindex, nofollow');
    expect(robots.getAttribute(ROBOTS_LOCK_ATTRIBUTE)).toBe('unavailable');

    const ready = resolvePublicRoute('/', DEFAULT_SITE_CONTENT, 'ready', ORIGIN);
    applyPublicHead(document, buildPublicHead(ready, DEFAULT_SITE_CONTENT, ORIGIN));
    expect(robots.content).toBe('noindex, nofollow');
  });

  it('keeps ordinary 404 noindex state route-scoped instead of locking the document', () => {
    const missing = resolvePublicRoute('/missing-page', DEFAULT_SITE_CONTENT, 'ready', ORIGIN);
    applyPublicHead(document, buildPublicHead(missing, DEFAULT_SITE_CONTENT, ORIGIN));
    const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')!;
    expect(robots.content).toBe('noindex, nofollow');
    expect(robots.hasAttribute(ROBOTS_LOCK_ATTRIBUTE)).toBe(false);

    const found = resolvePublicRoute('/blog', DEFAULT_SITE_CONTENT, 'ready', ORIGIN);
    applyPublicHead(document, buildPublicHead(found, DEFAULT_SITE_CONTENT, ORIGIN));
    expect(robots.content).toBe('index, follow');
  });
});
