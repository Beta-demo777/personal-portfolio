import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import { blogPostPath } from '../src/routing';
import { PublicSiteRenderer, resolvePublicRoute } from './publicSite';

const ORIGIN = 'https://portfolio.test';
const TEMPLATE = `<!doctype html><html><head>
<!--portfolio-default-head-start--><title>fallback</title><!--portfolio-default-head-end-->
</head><body><div id="root"><!--portfolio-app--></div><!--portfolio-bootstrap--></body></html>`;

function contentResponse(content = DEFAULT_SITE_CONTENT): Response {
  return new Response(JSON.stringify(content), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ETag: '"content-v1"',
    },
  });
}

test('resolves canonical detail routes and rejects nested soft-404 paths', () => {
  const post = DEFAULT_SITE_CONTENT.blogPosts[0];
  const canonical = blogPostPath(post);
  const byId = resolvePublicRoute(
    `/blog/${encodeURIComponent(post.id)}`,
    DEFAULT_SITE_CONTENT,
    'ready',
    ORIGIN,
  );
  if (canonical !== `/blog/${encodeURIComponent(post.id)}`) {
    assert.equal(byId.redirectPath, canonical);
  }

  assert.equal(
    resolvePublicRoute('/blog/post/extra', DEFAULT_SITE_CONTENT, 'ready', ORIGIN).statusCode,
    404,
  );
  assert.equal(
    resolvePublicRoute('/blog/not-present', DEFAULT_SITE_CONTENT, 'stale', ORIGIN).statusCode,
    503,
  );
  assert.equal(
    resolvePublicRoute('/blog/not-present', DEFAULT_SITE_CONTENT, 'ready', ORIGIN).statusCode,
    404,
  );
  assert.equal(resolvePublicRoute('/', DEFAULT_SITE_CONTENT, 'stale', ORIGIN).statusCode, 200);
  assert.equal(resolvePublicRoute('/', DEFAULT_SITE_CONTENT, 'unavailable', ORIGIN).statusCode, 503);
});

test('server-rendered article HTML contains content, metadata, JSON-LD, and bootstrap state', async () => {
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => contentResponse(),
    now: () => Date.UTC(2026, 6, 17),
  });
  const post = DEFAULT_SITE_CONTENT.blogPosts[0];
  const rendered = await renderer.render(blogPostPath(post));

  assert.equal(rendered.statusCode, 200);
  assert.match(rendered.body, new RegExp(post.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rendered.body, /<meta property="og:type" content="article"/);
  assert.match(rendered.body, new RegExp(`<meta name="twitter:url" content="${ORIGIN}${blogPostPath(post)}"`));
  assert.match(rendered.body, /<meta name="twitter:type" content="article"/);
  assert.match(rendered.body, /<script type="application\/ld\+json"[^>]*>/);
  assert.match(rendered.body, /<template id="portfolio-bootstrap">/);
  assert.doesNotMatch(rendered.body, /portfolio-default-head/);
  assert.doesNotMatch(rendered.body, /<!--portfolio-app-->/);
});

test('legacy query redirects and dynamic discovery files include published resources', async () => {
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => contentResponse(),
  });
  const post = DEFAULT_SITE_CONTENT.blogPosts[0];
  const legacy = await renderer.render(`/?post=${encodeURIComponent(post.id)}`);
  assert.equal(legacy.redirectPath, blogPostPath(post));

  const sitemap = await renderer.sitemap();
  const rss = await renderer.rss();
  assert.equal(sitemap.statusCode, 200);
  assert.equal(rss.statusCode, 200);
  assert.match(sitemap.body, new RegExp(blogPostPath(post)));
  assert.match(sitemap.body, /\/portfolio/);
  assert.match(rss.body, /<rss version="2.0">/);
  assert.match(rss.body, new RegExp(post.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rss.body, new RegExp(new Date(`${post.date}T00:00:00Z`).toUTCString()));
});

test('SSR and discovery metadata use absolute article images and valid JSON-LD', async () => {
  const content = structuredClone(DEFAULT_SITE_CONTENT);
  content.blogPosts[0].slug = 'metadata-contract';
  content.blogPosts[0].coverImage = '/backend/uploads/cover.png';
  const post = content.blogPosts[0];
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => contentResponse(content),
  });

  const article = await renderer.render(blogPostPath(post));
  assert.match(article.body, new RegExp(`<meta property="og:image" content="${ORIGIN}/backend/uploads/cover.png"`));
  assert.match(article.body, new RegExp(`<meta name="twitter:image" content="${ORIGIN}/backend/uploads/cover.png"`));
  assert.match(article.body, /<meta name="twitter:card" content="summary_large_image"/);
  const jsonLdMatch = article.body.match(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/);
  assert.ok(jsonLdMatch);
  const jsonLd = JSON.parse(jsonLdMatch[1]) as { '@graph': Array<Record<string, unknown>> };
  assert.ok(jsonLd['@graph'].some((item) => (
    item['@type'] === 'BlogPosting'
    && item.image === `${ORIGIN}/backend/uploads/cover.png`
    && item.datePublished === post.date
  )));

  const blog = await renderer.render('/blog');
  assert.doesNotMatch(blog.body, /property="og:image"/);
  assert.doesNotMatch(blog.body, /name="twitter:image"/);
  assert.match(blog.body, /<meta name="twitter:card" content="summary"/);
});

test('CMS response limits fail closed to the compiled fallback', async () => {
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    contentLimitBytes: 64,
    fetchImpl: async () => contentResponse(),
  });
  const snapshot = await renderer.loadContent();
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.content.siteSettings.siteTitle, DEFAULT_SITE_CONTENT.siteSettings.siteTitle);
});

test('CMS response limits cancel an undeclared oversized stream before it is buffered', async () => {
  let cancelled = false;
  let producedChunks = 0;
  const oversizedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      producedChunks += 1;
      controller.enqueue(new Uint8Array(40));
      if (producedChunks === 10) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    contentLimitBytes: 64,
    fetchImpl: async () => new Response(oversizedBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const snapshot = await renderer.loadContent();

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(cancelled, true);
  assert.ok(producedChunks < 10);
});

test('invalid CMS contracts fail closed instead of reaching normalization', async () => {
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => new Response(JSON.stringify({ blogPosts: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const snapshot = await renderer.loadContent();
  const rendered = await renderer.render('/');
  const sitemap = await renderer.sitemap();
  const rss = await renderer.rss();

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(rendered.statusCode, 503);
  assert.match(rendered.body, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(rendered.body, /data-portfolio-robots-lock="unavailable"/);
  assert.equal(sitemap.statusCode, 503);
  assert.equal(rss.statusCode, 503);
});

test('partial CMS documents fail closed instead of filling missing sections with defaults', async () => {
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => new Response(JSON.stringify({
      siteSettings: DEFAULT_SITE_CONTENT.siteSettings,
      blogPosts: DEFAULT_SITE_CONTENT.blogPosts,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const snapshot = await renderer.loadContent();
  const rendered = await renderer.render('/');

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(rendered.statusCode, 503);
  assert.match(rendered.body, /<meta name="robots" content="noindex, nofollow"/);
});

test('stale CMS content is distinct from compiled unavailable content', async () => {
  let now = 0;
  let requests = 0;
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    now: () => now,
    cacheTtlMs: 10,
    staleTtlMs: 100,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) return contentResponse();
      throw new Error('offline');
    },
  });

  assert.equal((await renderer.loadContent()).status, 'ready');
  now = 20;
  assert.equal((await renderer.loadContent()).status, 'stale');
  now = 101;
  assert.equal((await renderer.loadContent()).status, 'unavailable');
});

test('an empty CMS document is unavailable rather than indexable default content', async () => {
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const rendered = await renderer.render('/');
  assert.equal(rendered.statusCode, 503);
  assert.match(rendered.body, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(rendered.body, /data-portfolio-robots-lock="unavailable"/);
});

test('an invalid CMS article date fails closed before RSS or JSON-LD generation', async () => {
  const content = structuredClone(DEFAULT_SITE_CONTENT);
  content.blogPosts[0].date = '2026-02-30';
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => contentResponse(content),
  });

  const snapshot = await renderer.loadContent();
  const rendered = await renderer.render('/blog');
  const rss = await renderer.rss();

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(rendered.statusCode, 503);
  assert.match(rendered.body, /data-portfolio-robots-lock="unavailable"/);
  assert.equal(rss.statusCode, 503);
});

test('concurrent cache misses share one CMS request', async () => {
  let resolveRequest: ((response: Response) => void) | undefined;
  let requests = 0;
  const renderer = new PublicSiteRenderer({
    template: TEMPLATE,
    publicOrigin: ORIGIN,
    cmsOrigin: 'http://cms.test',
    fetchImpl: async () => {
      requests += 1;
      return new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
    },
  });

  const first = renderer.loadContent();
  const second = renderer.loadContent();
  assert.equal(requests, 1);
  resolveRequest?.(contentResponse());

  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.equal(firstSnapshot.status, 'ready');
  assert.equal(secondSnapshot.status, 'ready');
});
