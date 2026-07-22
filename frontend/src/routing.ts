import type { BlogPost, PageId, Project } from './types';

const ROUTE_KEY_CHARACTER = /^[\p{L}\p{N}_-]$/u;
const ROUTE_KEY_ALPHANUMERIC = /[\p{L}\p{N}]/u;

export function normalizeRouteKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isRouteSafeKey(value: string, maxLength: number): boolean {
  const characters = [...value];
  return value === value.trim()
    && characters.length > 0
    && characters.length <= maxLength
    && characters.some((character) => ROUTE_KEY_ALPHANUMERIC.test(character))
    && characters.every((character) => ROUTE_KEY_CHARACTER.test(character));
}

export interface BlogPostRouteKeyConflict {
  routeKey: string;
  firstIndex: number;
  secondIndex: number;
}

export function findBlogPostRouteKeyConflict(
  posts: Array<Pick<BlogPost, 'id' | 'slug'>>,
): BlogPostRouteKeyConflict | null {
  const owners = new Map<string, number>();
  for (const [index, post] of posts.entries()) {
    const aliases = post.slug === undefined ? [post.id] : [post.id, post.slug];
    for (const alias of aliases) {
      const routeKey = normalizeRouteKey(alias);
      const owner = owners.get(routeKey);
      if (owner !== undefined && owner !== index) {
        return { routeKey, firstIndex: owner, secondIndex: index };
      }
      owners.set(routeKey, index);
    }
  }
  return null;
}

export const PAGE_PATHS: Record<PageId, string> = {
  home: '/',
  showcase: '/portfolio',
  blog: '/blog',
  agent: '/agent',
  about: '/about',
};

export function pagePath(page: PageId): string {
  return PAGE_PATHS[page];
}

export function blogPostPath(post: Pick<BlogPost, 'id' | 'slug'>): string {
  return `/blog/${encodeURIComponent(post.slug?.trim() || post.id)}`;
}

export function projectPath(project: Pick<Project, 'id'>): string {
  return `/portfolio/${encodeURIComponent(project.id)}`;
}

export function pageIdFromPathname(pathname: string): PageId | null {
  const normalized = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname;
  const parts = normalized.split('/');
  if (normalized === '/') return 'home';
  if (normalized === '/portfolio' || (parts.length === 3 && parts[1] === 'portfolio' && parts[2])) return 'showcase';
  if (normalized === '/blog' || (parts.length === 3 && parts[1] === 'blog' && parts[2])) return 'blog';
  if (normalized === '/agent') return 'agent';
  if (normalized === '/about') return 'about';
  return null;
}

export function legacyPublicPath(search: string, posts: BlogPost[]): string | null {
  const params = new URLSearchParams(search);
  const requestedPost = params.get('post')?.trim();
  if (requestedPost) {
    const match = posts.find((post) => post.id === requestedPost || post.slug === requestedPost);
    return match
      ? blogPostPath(match)
      : `/blog/${encodeURIComponent(requestedPost)}`;
  }

  const preview = params.get('preview');
  if (preview && Object.prototype.hasOwnProperty.call(PAGE_PATHS, preview)) {
    return pagePath(preview as PageId);
  }
  return null;
}
