import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  ABOUT_PAGE,
  AGENT_PAGE,
  BLOG_PAGE,
  BLOG_POSTS,
  HOME_PAGE,
  MUSIC_PLAYER,
  PERSONAL_INFO,
  PROJECTS,
  SHOWCASE_PAGE,
  SITE_SETTINGS,
  TECH_STACK_GROUPS,
} from './data';
import type {
  AboutPageContent,
  AgentPageContent,
  BlogPageContent,
  BlogPost,
  HomePageContent,
  MusicPlayerContent,
  Project,
  ShowcasePageContent,
  SiteSettings,
  TechStackGroup,
} from './types';
import { isSiteContent } from './contentValidation';

export interface SiteContent {
  personalInfo: typeof PERSONAL_INFO;
  techStackGroups: TechStackGroup[];
  projects: Project[];
  blogPosts: BlogPost[];
  siteSettings: SiteSettings;
  homePage: HomePageContent;
  showcasePage: ShowcasePageContent;
  blogPage: BlogPageContent;
  aboutPage: AboutPageContent;
  agentPage: AgentPageContent;
  musicPlayer: MusicPlayerContent;
}

type LegacyBlogPost = Omit<BlogPost, 'status'> & { status?: BlogPost['status'] };
export type RemoteSiteContent = Omit<Partial<SiteContent>, 'blogPosts'> & {
  blogPosts?: LegacyBlogPost[];
};

export const DEFAULT_SITE_CONTENT: SiteContent = {
  personalInfo: PERSONAL_INFO,
  techStackGroups: TECH_STACK_GROUPS,
  projects: PROJECTS,
  blogPosts: BLOG_POSTS,
  siteSettings: SITE_SETTINGS,
  homePage: HOME_PAGE,
  showcasePage: SHOWCASE_PAGE,
  blogPage: BLOG_PAGE,
  aboutPage: ABOUT_PAGE,
  agentPage: AGENT_PAGE,
  musicPlayer: MUSIC_PLAYER,
};

export function createDraftBlogPost(now: Date = new Date()): BlogPost {
  return {
    id: `post-${now.getTime()}`,
    title: '未命名文章',
    excerpt: '',
    content: '# 新文章\n\n开始写作…',
    date: now.toISOString().slice(0, 10),
    readTime: '5 min read',
    category: '未分类',
    tags: [],
    views: 0,
    likes: 0,
    status: 'draft',
  };
}

const LEGACY_SIMULATED_CONTACT_DESCRIPTION = '向我投递信号。信息通过加密模拟传输，传输日志会输出到终端。';

export function normalizeSiteContent(remote?: RemoteSiteContent | null): SiteContent {
  if (!remote) return DEFAULT_SITE_CONTENT;

  return {
    personalInfo: {
      ...DEFAULT_SITE_CONTENT.personalInfo,
      ...(remote.personalInfo || {}),
      experience: remote.personalInfo?.experience ?? DEFAULT_SITE_CONTENT.personalInfo.experience,
    },
    techStackGroups: remote.techStackGroups ?? DEFAULT_SITE_CONTENT.techStackGroups,
    projects: (remote.projects ?? DEFAULT_SITE_CONTENT.projects).map((project) => ({
      ...project,
      tags: project.tags ?? [],
      stats: project.stats ?? {},
      featured: project.featured ?? false,
    })),
    blogPosts: (remote.blogPosts ?? DEFAULT_SITE_CONTENT.blogPosts).map((post) => ({
      ...post,
      tags: post.tags ?? [],
      views: post.views ?? 0,
      likes: post.likes ?? 0,
      // Content saved before publication states existed was public. Migrate that
      // legacy representation at the input boundary so all in-app posts are explicit.
      status: post.status === undefined ? 'published' : post.status,
      slug: typeof post.slug === 'string' && post.slug.trim() ? post.slug.trim() : undefined,
      seoTitle: typeof post.seoTitle === 'string' && post.seoTitle.trim() ? post.seoTitle.trim() : undefined,
      seoDescription: typeof post.seoDescription === 'string' && post.seoDescription.trim() ? post.seoDescription.trim() : undefined,
      scheduledAt: typeof post.scheduledAt === 'string' && post.scheduledAt.trim() ? post.scheduledAt.trim() : undefined,
    })),
    siteSettings: {
      ...DEFAULT_SITE_CONTENT.siteSettings,
      ...(remote.siteSettings || {}),
      navigation: remote.siteSettings?.navigation ?? DEFAULT_SITE_CONTENT.siteSettings.navigation,
      footerBadges: remote.siteSettings?.footerBadges ?? DEFAULT_SITE_CONTENT.siteSettings.footerBadges,
    },
    homePage: {
      ...DEFAULT_SITE_CONTENT.homePage,
      ...(remote.homePage || {}),
      greetings: remote.homePage?.greetings ?? DEFAULT_SITE_CONTENT.homePage.greetings,
      highlights: remote.homePage?.highlights ?? DEFAULT_SITE_CONTENT.homePage.highlights,
    },
    showcasePage: { ...DEFAULT_SITE_CONTENT.showcasePage, ...(remote.showcasePage || {}) },
    blogPage: { ...DEFAULT_SITE_CONTENT.blogPage, ...(remote.blogPage || {}) },
    aboutPage: {
      ...DEFAULT_SITE_CONTENT.aboutPage,
      ...(remote.aboutPage || {}),
      introduction: remote.aboutPage?.introduction ?? DEFAULT_SITE_CONTENT.aboutPage.introduction,
      hobbies: remote.aboutPage?.hobbies ?? DEFAULT_SITE_CONTENT.aboutPage.hobbies,
      contactDescription: remote.aboutPage?.contactDescription === LEGACY_SIMULATED_CONTACT_DESCRIPTION
        ? DEFAULT_SITE_CONTENT.aboutPage.contactDescription
        : remote.aboutPage?.contactDescription ?? DEFAULT_SITE_CONTENT.aboutPage.contactDescription,
    },
    agentPage: {
      ...DEFAULT_SITE_CONTENT.agentPage,
      ...(remote.agentPage || {}),
      samplePrompts: remote.agentPage?.samplePrompts ?? DEFAULT_SITE_CONTENT.agentPage.samplePrompts,
      funQuotes: remote.agentPage?.funQuotes ?? DEFAULT_SITE_CONTENT.agentPage.funQuotes,
    },
    musicPlayer: {
      ...DEFAULT_SITE_CONTENT.musicPlayer,
      ...(remote.musicPlayer || {}),
      tracks: remote.musicPlayer?.tracks ?? DEFAULT_SITE_CONTENT.musicPlayer.tracks,
    },
  };
}

const SiteContentContext = createContext<SiteContent>(DEFAULT_SITE_CONTENT);
export type SiteContentStatus = 'loading' | 'ready' | 'stale' | 'unavailable';
const SiteContentStatusContext = createContext<SiteContentStatus>('loading');

interface SiteContentProviderProps {
  children: ReactNode;
  initialContent?: RemoteSiteContent | null;
  initialStatus?: SiteContentStatus;
}

export function SiteContentProvider({
  children,
  initialContent,
  initialStatus = 'loading',
}: SiteContentProviderProps) {
  const [content, setContent] = useState(() => normalizeSiteContent(initialContent));
  const [status, setStatus] = useState<SiteContentStatus>(initialStatus);

  useEffect(() => {
    let previewContentReceived = false;
    const controller = new AbortController();
    const handlePreviewContent = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (window.parent === window || event.source !== window.parent) return;
      if (event.data?.type !== 'portfolio-content-preview' || !isSiteContent(event.data.payload)) return;
      previewContentReceived = true;
      setContent(normalizeSiteContent(event.data.payload));
      setStatus('ready');
    };

    window.addEventListener('message', handlePreviewContent);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'portfolio-preview-ready' }, window.location.origin);
    }

    if (initialContent && initialStatus === 'ready') {
      return () => {
        controller.abort();
        window.removeEventListener('message', handlePreviewContent);
      };
    }

    fetch('/backend/api/v1/content', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Content API unavailable')))
      .then((remote) => {
        if (previewContentReceived) return;
        const emptyDocument = typeof remote === 'object'
          && remote !== null
          && !Array.isArray(remote)
          && Object.keys(remote).length === 0;
        if (emptyDocument) {
          setStatus('unavailable');
        } else if (isSiteContent(remote)) {
          setContent(normalizeSiteContent(remote));
          setStatus('ready');
        } else {
          throw new Error('Content API returned an invalid payload');
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // The compiled defaults keep the public site available during backend maintenance.
        setStatus((current) => current === 'stale' ? 'stale' : 'unavailable');
      });

    return () => {
      controller.abort();
      window.removeEventListener('message', handlePreviewContent);
    };
  }, [initialContent, initialStatus]);

  return (
    <SiteContentStatusContext.Provider value={status}>
      <SiteContentContext.Provider value={content}>{children}</SiteContentContext.Provider>
    </SiteContentStatusContext.Provider>
  );
}

export function useSiteContent() {
  return useContext(SiteContentContext);
}

export function useSiteContentStatus() {
  return useContext(SiteContentStatusContext);
}
