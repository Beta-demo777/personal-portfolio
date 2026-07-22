import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import {
  collectRuntimeErrors,
  mockPublicContent,
  primaryPost,
  primaryPostPath,
  primaryProjectPath,
} from './support';

const publicOrigin = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 4173)}`;
const DEFAULT_BLOG_HEADING = DEFAULT_SITE_CONTENT.blogPage.title;

test.describe('public SSR delivery', () => {
  test('returns article HTML with content and route metadata before JavaScript runs', async ({ request }) => {
    const response = await request.get(primaryPostPath);
    const html = await response.text();

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    expect(html).toContain(primaryPost.title);
    expect(html).toContain(`<link rel="canonical" href="${publicOrigin}${primaryPostPath}"`);
    expect(html).toContain('<meta property="og:type" content="article"');
    expect(html).toContain('<script type="application/ld+json"');
    expect(html).toContain('<template id="portfolio-bootstrap">');
    expect(html).not.toContain('<!--portfolio-app-->');
  });

  test('uses real 404 responses and permanent redirects for legacy links', async ({ request }) => {
    const missing = await request.get('/definitely-not-a-public-route');
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toContain('noindex, nofollow');

    const legacy = await request.get(`/?post=${encodeURIComponent(primaryPost.id)}`, {
      maxRedirects: 0,
    });
    expect(legacy.status()).toBe(308);
    expect(legacy.headers().location).toBe(primaryPostPath);
  });
});

test.describe('public browser behavior', () => {
  test('hydrates without runtime errors and keeps navigation client-side', async ({ page }) => {
    await mockPublicContent(page);
    const runtimeErrors = collectRuntimeErrors(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, '__portfolioE2EDocumentId', {
        configurable: false,
        value: crypto.randomUUID(),
      });
    });

    await page.goto(primaryPostPath);
    await expect(page.getByRole('heading', { level: 1, name: primaryPost.title })).toBeVisible();
    const documentId = await page.evaluate(() => (
      window as typeof window & { __portfolioE2EDocumentId: string }
    ).__portfolioE2EDocumentId);

    await page.getByRole('link', { name: '博客' }).first().click();
    await expect(page).toHaveURL('/blog');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __portfolioE2EDocumentId: string }
    ).__portfolioE2EDocumentId)).toBe(documentId);
    expect(runtimeErrors).toEqual([]);
  });

  test('keeps focus, history, and route metadata synchronized across SPA navigation', async ({ page }) => {
    await mockPublicContent(page);
    await page.goto('/blog');

    await page.getByRole('link', { name: primaryPost.title }).click();
    await expect(page).toHaveURL(primaryPostPath);
    await expect(page.getByRole('heading', { level: 1, name: primaryPost.title })).toBeFocused();
    await expect(page.locator('#public-route-announcer')).toContainText(primaryPost.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${publicOrigin}${primaryPostPath}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', `${publicOrigin}${primaryPostPath}`);
    await expect(page.locator('meta[name="twitter:url"]')).toHaveAttribute('content', `${publicOrigin}${primaryPostPath}`);
    await expect(page.locator('meta[name="twitter:type"]')).toHaveAttribute('content', 'article');
    const articleGraph = await page.locator('#portfolio-public-json-ld').evaluate((element) => (
      JSON.parse(element.textContent || '{}')['@graph'] as Array<Record<string, unknown>>
    ));
    expect(articleGraph).toEqual(expect.arrayContaining([
      expect.objectContaining({
        '@type': 'BlogPosting',
        headline: primaryPost.seoTitle || primaryPost.title,
        datePublished: primaryPost.date,
        mainEntityOfPage: `${publicOrigin}${primaryPostPath}`,
      }),
    ]));
    await page.waitForTimeout(1_600);
    await expect(page.getByRole('heading', { level: 1, name: primaryPost.title })).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL('/blog');
    await expect(page.getByRole('heading', { level: 1, name: DEFAULT_BLOG_HEADING })).toBeFocused();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${publicOrigin}/blog`);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'website');
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
    await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(0);
    const listGraph = await page.locator('#portfolio-public-json-ld').evaluate((element) => (
      JSON.parse(element.textContent || '{}')['@graph'] as Array<Record<string, unknown>>
    ));
    expect(listGraph.some((item) => item['@type'] === 'BlogPosting')).toBe(false);

    await page.goForward();
    await expect(page).toHaveURL(primaryPostPath);
    await expect(page.getByRole('heading', { level: 1, name: primaryPost.title })).toBeFocused();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: primaryPost.title })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${publicOrigin}${primaryPostPath}`);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
  });

  test('never reindexes a document whose SSR bootstrap marked the CMS unavailable', async ({ page }) => {
    let clientContentRequests = 0;
    await page.route('**/backend/api/v1/content', async (route) => {
      clientContentRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DEFAULT_SITE_CONTENT),
      });
    });
    await page.route(`${publicOrigin}/`, async (route) => {
      const response = await route.fetch();
      const original = await response.text();
      const unavailable = original
        .replace(
          '<meta name="robots" content="index, follow" />',
          '<meta name="robots" content="noindex, nofollow" data-portfolio-robots-lock="unavailable" />',
        )
        .replace('"status":"ready","renderYear"', '"status":"unavailable","renderYear"');
      expect(unavailable).not.toBe(original);
      await route.fulfill({ response, status: 503, body: unavailable });
    });

    const response = await page.goto('/');
    expect(response?.status()).toBe(503);
    await expect.poll(() => clientContentRequests).toBe(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'data-portfolio-robots-lock',
      'unavailable',
    );

    await page.getByRole('link', { name: '博客' }).first().click();
    await expect(page).toHaveURL('/blog');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${publicOrigin}/blog`);
  });

  test('supports the skip link and primary navigation from the keyboard', async ({ page }) => {
    await mockPublicContent(page);
    await page.goto('/');

    const skipLink = page.getByRole('link', { name: '跳转到主要内容' });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    const portfolioLink = page.getByRole('link', { name: '作品集' }).first();
    await portfolioLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/portfolio');
  });

  const viewports = [
    { width: 320, height: 812 },
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1440, height: 1000 },
    { width: 1600, height: 1000 },
  ];
  const routes = ['/', '/portfolio', '/blog', primaryPostPath, '/agent', '/about'];

  for (const viewport of viewports) {
    for (const route of routes) {
      test(`has no document-level horizontal overflow on ${route} at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await mockPublicContent(page);
        await page.goto(route);
        await expect(page.locator('#app-root')).toBeVisible();
        const overflow = await page.evaluate(() => ({
          body: document.body.scrollWidth - document.body.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        expect(overflow, `Horizontal overflow on ${route} at ${viewport.width}px`).toEqual({
          body: 0,
          document: 0,
        });
      });
    }
  }

  for (const route of [
    '/',
    '/portfolio',
    primaryProjectPath,
    '/blog',
    primaryPostPath,
    '/agent',
    '/about',
    '/definitely-not-a-public-route',
  ]) {
    test(`has no serious or critical axe violations on ${route}`, async ({ page }) => {
      await mockPublicContent(page);
      await page.goto(route);
      await expect(page.locator('#app-root')).toBeVisible();
      await expect(page.locator('#main-content > div')).toHaveCSS('opacity', '1');
      await page.waitForTimeout(600);

      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const violations = result.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(
        violations.map(({ id, impact, nodes }) => ({
          id,
          impact,
          nodes: nodes.map((node) => ({
            target: node.target,
            html: node.html,
            failureSummary: node.failureSummary,
            any: node.any.map(({ data, message }) => ({ data, message })),
          })),
        })),
      ).toEqual([]);
    });
  }
});
