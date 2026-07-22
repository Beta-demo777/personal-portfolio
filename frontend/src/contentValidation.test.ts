import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_CONTENT } from './content';
import { isIsoCalendarDate, isSiteContent } from './contentValidation';

describe('public content runtime dates', () => {
  it('accepts only valid ISO-8601 full dates in YYYY-MM-DD form', () => {
    for (const value of ['2024-02-29', '2026-07-17', '9999-12-31']) {
      expect(isIsoCalendarDate(value), value).toBe(true);
    }
    for (const value of [
      '2023-02-29',
      '2026-02-30',
      '2026-7-17',
      '2026-07-17T00:00:00Z',
      ' 2026-07-17',
      '0000-01-01',
    ]) {
      expect(isIsoCalendarDate(value), value).toBe(false);
    }
  });

  it('rejects an otherwise complete CMS payload with an invalid article date', () => {
    const invalidContent = structuredClone(DEFAULT_SITE_CONTENT);
    invalidContent.blogPosts[0].date = '2026-02-30';
    expect(isSiteContent(invalidContent)).toBe(false);
  });
});
