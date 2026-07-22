import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDraftBlogPost,
  DEFAULT_SITE_CONTENT,
  normalizeSiteContent,
  SiteContentProvider,
  useSiteContentStatus,
} from './content';

function ContentStatusProbe() {
  return createElement('span', null, useSiteContentStatus());
}

describe('normalizeSiteContent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns complete defaults when no remote content exists', () => {
    expect(normalizeSiteContent()).toBe(DEFAULT_SITE_CONTENT);
    expect(normalizeSiteContent(null)).toBe(DEFAULT_SITE_CONTENT);
  });

  it('fills optional collections and project statistics', () => {
    const normalized = normalizeSiteContent({
      projects: [{
        ...DEFAULT_SITE_CONTENT.projects[0],
        tags: undefined as unknown as string[],
        stats: undefined as unknown as typeof DEFAULT_SITE_CONTENT.projects[number]['stats'],
        featured: undefined as unknown as boolean,
      }],
      blogPosts: [{
        ...DEFAULT_SITE_CONTENT.blogPosts[0],
        tags: undefined as unknown as string[],
        views: undefined as unknown as number,
        likes: undefined as unknown as number,
        slug: '  stable-slug  ',
        seoTitle: '   ',
      }],
    });

    expect(normalized.projects[0]).toMatchObject({ tags: [], stats: {}, featured: false });
    expect(normalized.blogPosts[0]).toMatchObject({ tags: [], views: 0, likes: 0, slug: 'stable-slug' });
    expect(normalized.blogPosts[0].seoTitle).toBeUndefined();
  });

  it('explicitly migrates status-less legacy posts while new posts start as drafts', () => {
    const { status: _legacyStatus, ...legacyPost } = DEFAULT_SITE_CONTENT.blogPosts[0];
    const normalized = normalizeSiteContent({ blogPosts: [legacyPost] });

    expect(normalized.blogPosts[0].status).toBe('published');
    expect(createDraftBlogPost(new Date('2026-07-17T12:00:00Z'))).toMatchObject({
      id: 'post-1784289600000',
      date: '2026-07-17',
      status: 'draft',
    });
  });

  it('merges nested settings without discarding stable defaults', () => {
    const normalized = normalizeSiteContent({
      siteSettings: {
        ...DEFAULT_SITE_CONTENT.siteSettings,
        siteTitle: 'Updated title',
        navigation: undefined as unknown as typeof DEFAULT_SITE_CONTENT.siteSettings.navigation,
      },
      homePage: {
        ...DEFAULT_SITE_CONTENT.homePage,
        heroPrefix: 'Updated prefix',
        greetings: undefined as unknown as string[],
      },
    });

    expect(normalized.siteSettings.siteTitle).toBe('Updated title');
    expect(normalized.siteSettings.navigation).toEqual(DEFAULT_SITE_CONTENT.siteSettings.navigation);
    expect(normalized.homePage.heroPrefix).toBe('Updated prefix');
    expect(normalized.homePage.greetings).toEqual(DEFAULT_SITE_CONTENT.homePage.greetings);
  });

  it('does not declare CMS content ready before the request completes', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));

    render(createElement(SiteContentProvider, null, createElement(ContentStatusProbe)));
    expect(screen.getByText('loading')).toBeInTheDocument();

    resolveRequest?.(new Response(JSON.stringify(DEFAULT_SITE_CONTENT), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());
  });

  it('marks compiled content unavailable when the CMS cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(createElement(SiteContentProvider, null, createElement(ContentStatusProbe)));

    await waitFor(() => expect(screen.getByText('unavailable')).toBeInTheDocument());
  });

  it('preserves a stale server snapshot when client revalidation fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(createElement(
      SiteContentProvider,
      {
        initialContent: DEFAULT_SITE_CONTENT,
        initialStatus: 'stale',
        children: createElement(ContentStatusProbe),
      },
    ));

    await waitFor(() => expect(screen.getByText('stale')).toBeInTheDocument());
  });

  it('does not duplicate a successful SSR content request after hydration', async () => {
    const request = vi.spyOn(globalThis, 'fetch');

    render(createElement(
      SiteContentProvider,
      {
        initialContent: DEFAULT_SITE_CONTENT,
        initialStatus: 'ready',
        children: createElement(ContentStatusProbe),
      },
    ));

    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects structurally invalid CMS content at the runtime boundary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ blogPosts: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    render(createElement(SiteContentProvider, null, createElement(ContentStatusProbe)));

    await waitFor(() => expect(screen.getByText('unavailable')).toBeInTheDocument());
  });

  it('rejects partial CMS content instead of merging it with compiled defaults', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      siteSettings: DEFAULT_SITE_CONTENT.siteSettings,
      blogPosts: DEFAULT_SITE_CONTENT.blogPosts,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    render(createElement(SiteContentProvider, null, createElement(ContentStatusProbe)));

    await waitFor(() => expect(screen.getByText('unavailable')).toBeInTheDocument());
  });
});
