import type { SiteContent, SiteContentStatus } from './content';
import {
  blogPostPath,
  isRouteSafeKey,
  legacyPublicPath,
  normalizeRouteKey,
  projectPath,
} from './routing';
import type { BlogPost, Project } from './types';

export const PUBLIC_JSON_LD_ID = 'portfolio-public-json-ld';
export const ROBOTS_LOCK_ATTRIBUTE = 'data-portfolio-robots-lock';

export type PublicRouteKind =
  | 'home'
  | 'portfolio'
  | 'project'
  | 'blog'
  | 'post'
  | 'agent'
  | 'about'
  | 'not-found';

export interface ResolvedPublicRoute {
  kind: PublicRouteKind;
  canonicalPath: string;
  statusCode: 200 | 404 | 503;
  redirectPath?: string;
  post?: BlogPost;
  project?: Project;
}

export interface PublicHeadModel {
  title: string;
  description: string;
  canonicalUrl: string;
  imageUrl?: string;
  robots: 'index, follow' | 'noindex, nofollow';
  robotsLocked: boolean;
  openGraphType: 'article' | 'website';
  siteName: string;
  twitterCard: 'summary' | 'summary_large_image';
  jsonLd: {
    '@context': 'https://schema.org';
    '@graph': Array<Record<string, unknown>>;
  };
}

function decodeRouteKey(segment: string, maxLength: number): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return isRouteSafeKey(decoded, maxLength) ? decoded : null;
  } catch {
    return null;
  }
}

function normalizedMatch(value: string, candidate: string | undefined): boolean {
  return candidate !== undefined && normalizeRouteKey(candidate) === normalizeRouteKey(value);
}

export function resolvePublicRoute(
  requestUrl: string,
  content: SiteContent,
  contentStatus: SiteContentStatus,
  publicOrigin: string,
): ResolvedPublicRoute {
  const url = new URL(requestUrl, publicOrigin);
  const pathname = url.pathname;
  const canonicalWithoutSlash = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  if (canonicalWithoutSlash !== pathname) {
    return {
      kind: 'not-found',
      canonicalPath: canonicalWithoutSlash,
      statusCode: 200,
      redirectPath: `${canonicalWithoutSlash}${url.search}`,
    };
  }

  const availableStatus = contentStatus === 'unavailable' ? 503 : 200;

  if (pathname === '/') {
    const legacyPath = legacyPublicPath(url.search, content.blogPosts);
    if (legacyPath) {
      return { kind: 'home', canonicalPath: legacyPath, statusCode: 200, redirectPath: legacyPath };
    }
    return { kind: 'home', canonicalPath: '/', statusCode: availableStatus };
  }
  if (pathname === '/portfolio') return { kind: 'portfolio', canonicalPath: pathname, statusCode: availableStatus };
  if (pathname === '/blog') return { kind: 'blog', canonicalPath: pathname, statusCode: availableStatus };
  if (pathname === '/agent') return { kind: 'agent', canonicalPath: pathname, statusCode: availableStatus };
  if (pathname === '/about') return { kind: 'about', canonicalPath: pathname, statusCode: availableStatus };

  const parts = pathname.split('/');
  if (parts.length === 3 && parts[1] === 'blog') {
    const key = decodeRouteKey(parts[2], 200);
    const post = key
      ? content.blogPosts.find((candidate) => (
          normalizedMatch(key, candidate.id) || normalizedMatch(key, candidate.slug)
        ))
      : undefined;
    if (!post) {
      return {
        kind: 'not-found',
        canonicalPath: pathname,
        statusCode: contentStatus === 'ready' ? 404 : 503,
      };
    }
    const canonicalPath = blogPostPath(post);
    if (canonicalPath !== pathname) {
      return { kind: 'post', canonicalPath, statusCode: 200, redirectPath: canonicalPath, post };
    }
    return { kind: 'post', canonicalPath, statusCode: availableStatus, post };
  }

  if (parts.length === 3 && parts[1] === 'portfolio') {
    const key = decodeRouteKey(parts[2], 128);
    const project = key
      ? content.projects.find((candidate) => normalizedMatch(key, candidate.id))
      : undefined;
    if (!project) {
      return {
        kind: 'not-found',
        canonicalPath: pathname,
        statusCode: contentStatus === 'ready' ? 404 : 503,
      };
    }
    const canonicalPath = projectPath(project);
    if (canonicalPath !== pathname) {
      return { kind: 'project', canonicalPath, statusCode: 200, redirectPath: canonicalPath, project };
    }
    return { kind: 'project', canonicalPath, statusCode: availableStatus, project };
  }

  return { kind: 'not-found', canonicalPath: pathname, statusCode: 404 };
}

export function buildPublicHead(
  route: ResolvedPublicRoute,
  content: SiteContent,
  publicOrigin: string,
): PublicHeadModel {
  const { siteSettings, blogPage, showcasePage, agentPage, aboutPage, personalInfo } = content;
  const origin = new URL(publicOrigin).origin;
  const title = (() => {
    if (route.kind === 'post' && route.post) return route.post.seoTitle || route.post.title;
    if (route.kind === 'project' && route.project) return `${route.project.title} | ${siteSettings.siteTitle}`;
    if (route.kind === 'portfolio') return `${showcasePage.worksTitle} | ${siteSettings.siteTitle}`;
    if (route.kind === 'blog') return `${blogPage.title} | ${siteSettings.siteTitle}`;
    if (route.kind === 'agent') return `${agentPage.title} | ${siteSettings.siteTitle}`;
    if (route.kind === 'about') return `${aboutPage.title} | ${siteSettings.siteTitle}`;
    if (route.kind === 'not-found') return `页面不存在 | ${siteSettings.siteTitle}`;
    return siteSettings.siteTitle;
  })();
  const description = route.post?.seoDescription
    || route.post?.excerpt
    || route.project?.description
    || (route.kind === 'blog' ? blogPage.description : undefined)
    || (route.kind === 'agent' ? agentPage.description : undefined)
    || (route.kind === 'about' ? aboutPage.description : undefined)
    || siteSettings.siteDescription;
  const canonicalUrl = new URL(route.canonicalPath, origin).toString();
  const imageUrl = route.post?.coverImage
    ? new URL(route.post.coverImage, origin).toString()
    : undefined;

  const graph: Array<Record<string, unknown>> = [
    {
      '@type': 'Person',
      '@id': `${origin}/#person`,
      name: personalInfo.name,
      url: origin,
      jobTitle: personalInfo.title,
      sameAs: [personalInfo.github, personalInfo.twitter].filter(Boolean),
    },
    {
      '@type': 'WebSite',
      '@id': `${origin}/#website`,
      url: origin,
      name: siteSettings.siteTitle,
      description: siteSettings.siteDescription,
      inLanguage: 'zh-CN',
      author: { '@id': `${origin}/#person` },
    },
  ];
  if (route.post) {
    graph.push({
      '@type': 'BlogPosting',
      '@id': `${canonicalUrl}#article`,
      headline: route.post.seoTitle || route.post.title,
      description,
      datePublished: route.post.date,
      image: imageUrl,
      keywords: route.post.tags,
      mainEntityOfPage: canonicalUrl,
      author: { '@id': `${origin}/#person` },
    });
  } else if (route.project) {
    graph.push({
      '@type': 'CreativeWork',
      '@id': `${canonicalUrl}#project`,
      name: route.project.title,
      description: route.project.description,
      url: canonicalUrl,
      creator: { '@id': `${origin}/#person` },
    });
  }

  return {
    title,
    description,
    canonicalUrl,
    imageUrl,
    robots: route.statusCode === 200 ? 'index, follow' : 'noindex, nofollow',
    robotsLocked: route.statusCode === 503,
    openGraphType: route.post ? 'article' : 'website',
    siteName: personalInfo.name,
    twitterCard: imageUrl ? 'summary_large_image' : 'summary',
    jsonLd: { '@context': 'https://schema.org', '@graph': graph },
  };
}

export function publicRouteAnnouncement(
  route: ResolvedPublicRoute,
  content: SiteContent,
  contentStatus: SiteContentStatus,
): string {
  if (route.post) return route.post.title;
  if (route.project) return route.project.title;
  if (route.kind === 'home') {
    return `${content.homePage.heroPrefix}${content.homePage.heroHighlight} ${content.homePage.heroSuffix}`;
  }
  if (route.kind === 'portfolio') return content.personalInfo.name;
  if (route.kind === 'blog') return content.blogPage.title;
  if (route.kind === 'agent') return content.agentPage.title;
  if (route.kind === 'about') return content.aboutPage.title;

  const resource = route.canonicalPath.startsWith('/blog/')
    ? '文章'
    : route.canonicalPath.startsWith('/portfolio/')
      ? '项目'
      : '页面';
  if (route.statusCode === 503 && resource !== '页面') {
    return contentStatus === 'loading' ? `正在读取${resource}` : `${resource}内容暂时无法读取`;
  }
  return `没有找到这个${resource}`;
}

function ensureMeta(
  documentRoot: Document,
  attribute: 'name' | 'property',
  key: string,
): HTMLMetaElement {
  const selector = `meta[${attribute}="${key}"]`;
  const existing = documentRoot.head.querySelector<HTMLMetaElement>(selector);
  if (existing) return existing;
  const element = documentRoot.createElement('meta');
  element.setAttribute(attribute, key);
  element.dataset.portfolioManagedHead = 'true';
  documentRoot.head.append(element);
  return element;
}

function setMeta(
  documentRoot: Document,
  attribute: 'name' | 'property',
  key: string,
  value: string | undefined,
): void {
  const selector = `meta[${attribute}="${key}"]`;
  if (value === undefined) {
    documentRoot.head.querySelectorAll(selector).forEach((element) => element.remove());
    return;
  }
  ensureMeta(documentRoot, attribute, key).content = value;
}

export function applyPublicHead(documentRoot: Document, model: PublicHeadModel): void {
  documentRoot.title = model.title;
  setMeta(documentRoot, 'name', 'description', model.description);

  const robots = ensureMeta(documentRoot, 'name', 'robots');
  const robotsAlreadyLocked = robots.getAttribute(ROBOTS_LOCK_ATTRIBUTE) === 'unavailable';
  if (model.robotsLocked) robots.setAttribute(ROBOTS_LOCK_ATTRIBUTE, 'unavailable');
  robots.content = robotsAlreadyLocked || model.robotsLocked ? 'noindex, nofollow' : model.robots;

  let canonical = documentRoot.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = documentRoot.createElement('link');
    canonical.rel = 'canonical';
    canonical.dataset.portfolioManagedHead = 'true';
    documentRoot.head.append(canonical);
  }
  canonical.href = model.canonicalUrl;

  setMeta(documentRoot, 'property', 'og:type', model.openGraphType);
  setMeta(documentRoot, 'property', 'og:locale', 'zh_CN');
  setMeta(documentRoot, 'property', 'og:site_name', model.siteName);
  setMeta(documentRoot, 'property', 'og:title', model.title);
  setMeta(documentRoot, 'property', 'og:description', model.description);
  setMeta(documentRoot, 'property', 'og:url', model.canonicalUrl);
  setMeta(documentRoot, 'property', 'og:image', model.imageUrl);

  setMeta(documentRoot, 'name', 'twitter:card', model.twitterCard);
  setMeta(documentRoot, 'name', 'twitter:title', model.title);
  setMeta(documentRoot, 'name', 'twitter:description', model.description);
  setMeta(documentRoot, 'name', 'twitter:url', model.canonicalUrl);
  setMeta(documentRoot, 'name', 'twitter:type', model.openGraphType);
  setMeta(documentRoot, 'name', 'twitter:image', model.imageUrl);

  let jsonLd = documentRoot.getElementById(PUBLIC_JSON_LD_ID);
  if (!(jsonLd instanceof HTMLScriptElement)) {
    jsonLd?.remove();
    jsonLd = documentRoot.createElement('script');
    jsonLd.id = PUBLIC_JSON_LD_ID;
    jsonLd.setAttribute('type', 'application/ld+json');
    documentRoot.head.append(jsonLd);
  }
  jsonLd.textContent = JSON.stringify(model.jsonLd);
}
