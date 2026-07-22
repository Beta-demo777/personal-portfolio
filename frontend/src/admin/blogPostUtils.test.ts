import { describe, expect, it } from 'vitest';
import { countArticleText, getMarkdownOutline, getPostPublishChecks, slugifyPostTitle } from './blogPostUtils';
import { DEFAULT_SITE_CONTENT } from '../content';

describe('blog post utilities', () => {
  it('creates stable unicode-aware slugs', () => {
    expect(slugifyPostTitle('  React 19：路由 / SEO  ')).toBe('react-19路由-seo');
  });

  it('does not treat fenced code headings as article outline entries', () => {
    expect(getMarkdownOutline('# Intro\n\n```md\n## not-a-heading\n```\n\n### Details')).toEqual([
      { level: 1, text: 'Intro', line: 1 },
      { level: 3, text: 'Details', line: 7 },
    ]);
  });

  it('separates publish blockers from recommendations and counts mixed text', () => {
    const post = {
      ...DEFAULT_SITE_CONTENT.blogPosts[0],
      title: '',
      excerpt: '',
      content: '你好 React world',
      coverImage: undefined,
      tags: [],
    };
    expect(getPostPublishChecks(post)).toEqual({
      blocking: ['补充文章标题'],
      warnings: ['建议补充文章摘要', '建议设置封面图片', '建议添加文章标签'],
    });
    expect(countArticleText(post.content)).toMatchObject({ chineseCharacters: 2, latinWords: 2 });
  });
});
