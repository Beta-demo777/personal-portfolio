import type { BlogPost } from '../types';

export interface PostPublishChecks {
  blocking: string[];
  warnings: string[];
}

export interface MarkdownOutlineItem {
  level: 1 | 2 | 3;
  text: string;
  line: number;
}

export interface ArticleTextCount {
  chineseCharacters: number;
  latinWords: number;
  totalCharacters: number;
}

export function getPostPublishChecks(post: BlogPost): PostPublishChecks {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!post.title.trim()) blocking.push('补充文章标题');
  if (!post.content.trim()) blocking.push('补充正文内容');
  if (!post.excerpt.trim()) warnings.push('建议补充文章摘要');
  if (!post.coverImage?.trim()) warnings.push('建议设置封面图片');
  if (!post.category.trim()) warnings.push('建议选择文章分类');
  if (!post.tags.some((tag) => tag.trim())) warnings.push('建议添加文章标签');

  return { blocking, warnings };
}

export function getMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  const outline: MarkdownOutlineItem[] = [];
  let fenceCharacter = '';
  let fenceLength = 0;

  markdown.split(/\r\n?|\n/).forEach((line, index) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

    if (fenceCharacter) {
      if (
        fence
        && fence[1][0] === fenceCharacter
        && fence[1].length >= fenceLength
        && !fence[2].trim()
      ) {
        fenceCharacter = '';
        fenceLength = 0;
      }
      return;
    }

    if (fence) {
      fenceCharacter = fence[1][0];
      fenceLength = fence[1].length;
      return;
    }

    const heading = line.match(/^ {0,3}(#{1,3})(?:[ \t]+(.*)|[ \t]*)$/);
    if (!heading) return;

    const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (!text) return;

    outline.push({
      level: heading[1].length as MarkdownOutlineItem['level'],
      text,
      line: index + 1,
    });
  });

  return outline;
}

export function countArticleText(text: string): ArticleTextCount {
  return {
    chineseCharacters: text.match(/\p{Script=Han}/gu)?.length ?? 0,
    latinWords: text.match(/\p{Script=Latin}+(?:['\u2019]\p{Script=Latin}+)*/gu)?.length ?? 0,
    totalCharacters: Array.from(text).length,
  };
}

function padDatePart(value: number, length = 2) {
  return String(value).padStart(length, '0');
}

export function toDatetimeLocalValue(value?: string): string {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return [
    padDatePart(date.getFullYear(), 4),
    '-',
    padDatePart(date.getMonth() + 1),
    '-',
    padDatePart(date.getDate()),
    'T',
    padDatePart(date.getHours()),
    ':',
    padDatePart(date.getMinutes()),
  ].join('');
}

export function fromDatetimeLocalValue(value: string): string | undefined {
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (!match) return undefined;

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue = '0', millisecondValue = '0'] = match;
  const parts = {
    year: Number(yearValue),
    month: Number(monthValue),
    day: Number(dayValue),
    hour: Number(hourValue),
    minute: Number(minuteValue),
    second: Number(secondValue),
    millisecond: Number(millisecondValue.padEnd(3, '0')),
  };
  const date = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== parts.year
    || date.getMonth() !== parts.month - 1
    || date.getDate() !== parts.day
    || date.getHours() !== parts.hour
    || date.getMinutes() !== parts.minute
    || date.getSeconds() !== parts.second
    || date.getMilliseconds() !== parts.millisecond
  ) return undefined;

  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);

  return [
    padDatePart(parts.year, 4),
    '-',
    padDatePart(parts.month),
    '-',
    padDatePart(parts.day),
    'T',
    padDatePart(parts.hour),
    ':',
    padDatePart(parts.minute),
    ':',
    padDatePart(parts.second),
    offsetSign,
    padDatePart(Math.floor(absoluteOffset / 60)),
    ':',
    padDatePart(absoluteOffset % 60),
  ].join('');
}

export function slugifyPostTitle(title: string): string {
  return title
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
