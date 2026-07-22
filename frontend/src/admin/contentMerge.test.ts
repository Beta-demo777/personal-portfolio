import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_CONTENT } from '../content';
import { mergeSiteContentVersions } from './contentMerge';

function copyContent() {
  return structuredClone(DEFAULT_SITE_CONTENT);
}

function appendPost(content: ReturnType<typeof copyContent>, id: string) {
  const post = {
    ...structuredClone(content.blogPosts[0]),
    id,
    title: id,
  };
  content.blogPosts.push(post);
  return post;
}

describe('mergeSiteContentVersions', () => {
  it('preserves disjoint local and server changes in the same object', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    local.siteSettings.siteTitle = 'local title';
    server.siteSettings.siteDescription = 'server description';

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.siteSettings.siteTitle).toBe('local title');
    expect(result.content.siteSettings.siteDescription).toBe('server description');
  });

  it('defaults same-field conflicts to the server and exposes an explicit local resolution', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    local.siteSettings.siteTitle = 'local title';
    server.siteSettings.siteTitle = 'server title';

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toContain('siteSettings.siteTitle');
    expect(result.content.siteSettings.siteTitle).toBe('server title');
    expect(result.localResolution.siteSettings.siteTitle).toBe('local title');
  });

  it('merges edits to different entries in id-keyed content arrays', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    local.blogPosts[0].title = 'local first post';
    server.blogPosts[1].title = 'server second post';

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.blogPosts[0].title).toBe('local first post');
    expect(result.content.blogPosts[1].title).toBe('server second post');
  });

  it('preserves a local reorder when the server only edits an item', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    local.blogPosts.reverse();
    server.blogPosts[0].title = 'server title edit';

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.blogPosts.map((post) => post.id)).toEqual(local.blogPosts.map((post) => post.id));
    expect(result.content.blogPosts.find((post) => post.id === server.blogPosts[0].id)?.title)
      .toBe('server title edit');
  });

  it('merges concurrent additions without treating membership changes as an order conflict', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    const localPost = appendPost(local, 'local-addition');
    const serverPost = appendPost(server, 'server-addition');

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.blogPosts.map((post) => post.id)).toEqual([
      ...base.blogPosts.map((post) => post.id),
      localPost.id,
      serverPost.id,
    ]);
    expect(result.localResolution.blogPosts).toEqual(result.content.blogPosts);
  });

  it('keeps both resolutions for conflicting concurrent additions with the same id', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    const localPost = appendPost(local, 'shared-addition');
    const serverPost = appendPost(server, 'shared-addition');
    localPost.title = 'local addition';
    serverPost.title = 'server addition';

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toContain('blogPosts[id=shared-addition].title');
    expect(result.content.blogPosts.find((post) => post.id === localPost.id)?.title)
      .toBe('server addition');
    expect(result.localResolution.blogPosts.find((post) => post.id === localPost.id)?.title)
      .toBe('local addition');
  });

  it('removes an item deleted by both sides without reporting an order conflict', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    const deletedId = base.blogPosts[0].id;
    local.blogPosts = local.blogPosts.filter((post) => post.id !== deletedId);
    server.blogPosts = server.blogPosts.filter((post) => post.id !== deletedId);

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.blogPosts.some((post) => post.id === deletedId)).toBe(false);
    expect(result.localResolution.blogPosts).toEqual(result.content.blogPosts);
  });

  it('combines independent deletions from both sides', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    appendPost(base, 'third-post');
    appendPost(local, 'third-post');
    appendPost(server, 'third-post');
    const localDeletedId = base.blogPosts[0].id;
    const serverDeletedId = base.blogPosts[1].id;
    const expectedIds = base.blogPosts
      .map((post) => post.id)
      .filter((id) => id !== localDeletedId && id !== serverDeletedId);
    local.blogPosts = local.blogPosts.filter((post) => post.id !== localDeletedId);
    server.blogPosts = server.blogPosts.filter((post) => post.id !== serverDeletedId);

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.blogPosts.map((post) => post.id)).toEqual(expectedIds);
    expect(result.localResolution.blogPosts).toEqual(result.content.blogPosts);
  });

  it('exposes server edit and local deletion as switchable resolutions', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    const targetId = base.blogPosts[0].id;
    local.blogPosts = local.blogPosts.filter((post) => post.id !== targetId);
    server.blogPosts[0].title = 'server edit';

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toContain(`blogPosts[id=${targetId}]`);
    expect(result.conflicts).not.toContain('blogPosts.$order');
    expect(result.content.blogPosts.find((post) => post.id === targetId)?.title).toBe('server edit');
    expect(result.localResolution.blogPosts.some((post) => post.id === targetId)).toBe(false);
  });

  it('exposes server deletion and local edit as switchable resolutions', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    const targetId = base.blogPosts[0].id;
    local.blogPosts[0].title = 'local edit';
    server.blogPosts = server.blogPosts.filter((post) => post.id !== targetId);

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toContain(`blogPosts[id=${targetId}]`);
    expect(result.conflicts).not.toContain('blogPosts.$order');
    expect(result.content.blogPosts.some((post) => post.id === targetId)).toBe(false);
    expect(result.localResolution.blogPosts.find((post) => post.id === targetId)?.title)
      .toBe('local edit');
  });

  it('combines a local deletion with a server reorder of the surviving items', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    appendPost(base, 'third-post');
    appendPost(local, 'third-post');
    appendPost(server, 'third-post');
    const deletedId = base.blogPosts[1].id;
    const expectedOrder = [base.blogPosts[2].id, base.blogPosts[0].id];
    local.blogPosts = local.blogPosts.filter((post) => post.id !== deletedId);
    server.blogPosts = [server.blogPosts[2], server.blogPosts[0], server.blogPosts[1]];

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.content.blogPosts.map((post) => post.id)).toEqual(expectedOrder);
    expect(result.localResolution.blogPosts.map((post) => post.id)).toEqual(expectedOrder);
  });

  it('reports an explicit order conflict when both sides reorder the same id array', () => {
    const base = copyContent();
    const local = copyContent();
    const server = copyContent();
    const third = { ...structuredClone(base.blogPosts[0]), id: 'third-post', slug: 'third-post' };
    base.blogPosts.push(third);
    local.blogPosts = [base.blogPosts[1], base.blogPosts[0], base.blogPosts[2]];
    server.blogPosts = [base.blogPosts[0], base.blogPosts[2], base.blogPosts[1]];

    const result = mergeSiteContentVersions(base, local, server);

    expect(result.conflicts).toContain('blogPosts.$order');
    expect(result.content.blogPosts.map((post) => post.id)).toEqual(server.blogPosts.map((post) => post.id));
    expect(result.localResolution.blogPosts.map((post) => post.id)).toEqual(local.blogPosts.map((post) => post.id));
  });
});
