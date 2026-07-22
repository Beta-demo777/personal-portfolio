import { describe, expect, it } from 'vitest';
import { BLOG_POSTS } from './data';
import {
  blogPostPath,
  findBlogPostRouteKeyConflict,
  isRouteSafeKey,
  legacyPublicPath,
  normalizeRouteKey,
  pageIdFromPathname,
  pagePath,
  projectPath,
} from './routing';

describe('public routing', () => {
  it('maps public sections and detail resources to stable paths', () => {
    expect(pagePath('showcase')).toBe('/portfolio');
    expect(pageIdFromPathname('/portfolio/project-one')).toBe('showcase');
    expect(pageIdFromPathname('/blog/post-one/')).toBe('blog');
    expect(pageIdFromPathname('/blog/post-one/extra')).toBeNull();
    expect(pageIdFromPathname('/portfolio/project-one/extra')).toBeNull();
    expect(pageIdFromPathname('/unknown')).toBeNull();
    expect(projectPath({ id: 'project one' })).toBe('/portfolio/project%20one');
    expect(blogPostPath({ id: 'fallback', slug: '文章-one' })).toBe('/blog/%E6%96%87%E7%AB%A0-one');
  });

  it('replaces legacy post and preview queries with canonical routes', () => {
    const post = BLOG_POSTS[0];
    expect(legacyPublicPath(`?post=${encodeURIComponent(post.id)}`, BLOG_POSTS)).toBe(blogPostPath(post));
    expect(legacyPublicPath('?preview=showcase', BLOG_POSTS)).toBe('/portfolio');
    expect(legacyPublicPath('?preview=home', BLOG_POSTS)).toBe('/');
    expect(legacyPublicPath('?post=unpublished-id', BLOG_POSTS)).toBe('/blog/unpublished-id');
    expect(legacyPublicPath('?unrelated=value', BLOG_POSTS)).toBeNull();
  });

  it('uses the same safe route-key alphabet and normalization as the content API', () => {
    expect(normalizeRouteKey('  Article-ONE  ')).toBe('article-one');
    expect(isRouteSafeKey('工程_实践-2026', 200)).toBe(true);
    expect(isRouteSafeKey(' article', 200)).toBe(false);
    expect(isRouteSafeKey('article/path', 200)).toBe(false);
    expect(isRouteSafeKey('article.preview', 200)).toBe(false);
    expect(isRouteSafeKey('--', 200)).toBe(false);
    expect(isRouteSafeKey('article-🚀', 200)).toBe(false);
    expect(isRouteSafeKey('a'.repeat(129), 128)).toBe(false);
  });

  it('rejects route aliases owned by different posts after case normalization', () => {
    expect(findBlogPostRouteKeyConflict([
      { id: 'post-one', slug: 'canonical-one' },
      { id: 'post-two', slug: 'POST-ONE' },
    ])).toMatchObject({ routeKey: 'post-one', firstIndex: 0, secondIndex: 1 });
    expect(findBlogPostRouteKeyConflict([
      { id: 'post-one', slug: 'POST-ONE' },
    ])).toBeNull();
  });
});
