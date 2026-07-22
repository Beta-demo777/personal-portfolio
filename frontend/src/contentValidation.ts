import type { RemoteSiteContent, SiteContent } from './content';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringFields(value: unknown, fields: readonly string[]): value is UnknownRecord {
  return isRecord(value) && fields.every((field) => typeof value[field] === 'string');
}

function hasOptionalStrings(value: UnknownRecord, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === 'string');
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Accepts only the ISO-8601 full-date form used by the CMS date input. */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isPersonalInfo(value: unknown): boolean {
  if (!hasStringFields(value, ['name', 'title', 'bio', 'location', 'email', 'github', 'twitter'])) return false;
  return Array.isArray(value.experience)
    && value.experience.every((item) => hasStringFields(item, ['year', 'role', 'desc']));
}

function isTechStackGroups(value: unknown): boolean {
  return Array.isArray(value) && value.every((group) => (
    hasStringFields(group, ['id', 'title']) && isStringList(group.items)
  ));
}

function isProjects(value: unknown): boolean {
  return Array.isArray(value) && value.every((project) => {
    if (!hasStringFields(project, ['id', 'title', 'description', 'role', 'year'])) return false;
    if (!isStringList(project.tags) || typeof project.featured !== 'boolean') return false;
    if (!hasOptionalStrings(project, ['longDescription', 'url', 'github']) || !isRecord(project.stats)) return false;
    return (project.stats.stars === undefined || isNonNegativeInteger(project.stats.stars))
      && (project.stats.forks === undefined || isNonNegativeInteger(project.stats.forks))
      && (project.stats.impact === undefined || typeof project.stats.impact === 'string');
  });
}

function isBlogPosts(value: unknown): boolean {
  return Array.isArray(value) && value.every((post) => {
    if (!hasStringFields(post, ['id', 'title', 'excerpt', 'content', 'date', 'readTime', 'category'])) return false;
    if (!isIsoCalendarDate(post.date)) return false;
    if (!isStringList(post.tags) || !isNonNegativeInteger(post.views) || !isNonNegativeInteger(post.likes)) return false;
    if (!hasOptionalStrings(post, ['slug', 'coverImage', 'seoTitle', 'seoDescription', 'scheduledAt'])) return false;
    return post.status === undefined || post.status === 'draft' || post.status === 'published';
  });
}

function isSiteSettings(value: unknown): boolean {
  if (!hasStringFields(value, [
    'siteTitle',
    'siteDescription',
    'brandInitials',
    'footerCopyright',
    'icpNumber',
    'icpUrl',
  ])) return false;
  return Array.isArray(value.navigation)
    && value.navigation.every((item) => (
      hasStringFields(item, ['id', 'label'])
      && isOneOf(item.id, ['home', 'showcase', 'blog', 'agent', 'about'])
    ))
    && isStringList(value.footerBadges);
}

function isHomePage(value: unknown): boolean {
  if (!hasStringFields(value, [
    'heroPrefix',
    'heroHighlight',
    'heroSuffix',
    'introduction',
    'portfolioButton',
    'agentButton',
    'blogButton',
  ])) return false;
  return isStringList(value.greetings)
    && Array.isArray(value.highlights)
    && value.highlights.every((item) => (
      hasStringFields(item, ['id', 'title', 'description', 'icon'])
      && isOneOf(item.icon, ['code', 'layers', 'sparkles'])
    ));
}

function isShowcasePage(value: unknown): boolean {
  if (!hasStringFields(value, [
    'identityLabel',
    'terminalWelcome',
    'terminalHint',
    'terminalTitle',
    'terminalPlaceholder',
    'technologyTitle',
    'worksEyebrow',
    'worksTitle',
    'terminalPrompt',
    'quickLabel',
    'allFilterLabel',
    'commandNotFound',
    'detailsLabel',
    'repositoryLabel',
    'livePreviewLabel',
    'impactLabel',
    'starsLabel',
    'forksLabel',
  ])) return false;
  return isStringList(value.terminalHelp);
}

function isBlogPage(value: unknown): boolean {
  return hasStringFields(value, [
    'eyebrow',
    'title',
    'description',
    'searchPlaceholder',
    'noResultsText',
    'backLabel',
    'relatedTitle',
    'allCategoryLabel',
    'readsLabel',
    'likeLabel',
    'linkCopiedLabel',
  ]);
}

function isAboutPage(value: unknown): boolean {
  if (!hasStringFields(value, [
    'eyebrow',
    'title',
    'description',
    'introductionTitle',
    'experienceTitle',
    'hobbiesTitle',
    'technologyTitle',
    'contactEyebrow',
    'contactTitle',
    'contactDescription',
    'contactNamePlaceholder',
    'contactMessagePlaceholder',
    'contactSendingLabel',
    'contactSuccessLabel',
    'contactSubmitLabel',
  ])) return false;
  return isStringList(value.introduction)
    && Array.isArray(value.hobbies)
    && value.hobbies.every((item) => (
      hasStringFields(item, ['id', 'title', 'description', 'icon'])
      && isOneOf(item.icon, ['coffee', 'code', 'game', 'screen'])
    ));
}

function isAgentPage(value: unknown): boolean {
  if (!hasStringFields(value, [
    'title',
    'description',
    'welcomeMessage',
    'initialBubble',
    'loadingBubble',
    'answeredBubble',
    'resetBubble',
    'inputPlaceholder',
    'displayName',
    'badgeLabel',
    'modelLabel',
    'idleStatus',
    'loadingStatus',
    'interactionHint',
    'suggestionsTitle',
    'resetLabel',
  ])) return false;
  return Array.isArray(value.samplePrompts)
    && value.samplePrompts.every((item) => hasStringFields(item, ['label', 'text']))
    && isStringList(value.funQuotes);
}

function isMusicPlayer(value: unknown): boolean {
  if (!hasStringFields(value, ['title', 'minimizedLabel', 'standbyLabel', 'playingPrefix'])) return false;
  return Array.isArray(value.tracks) && value.tracks.every((track) => (
    hasStringFields(track, ['id', 'name', 'description', 'type'])
    && (track.type === 'synth' || track.type === 'noise')
    && typeof track.frequency === 'number'
    && Number.isFinite(track.frequency)
    && track.frequency >= 20
    && track.frequency <= 20_000
  ));
}

const TOP_LEVEL_VALIDATORS: Record<keyof SiteContent, (value: unknown) => boolean> = {
  personalInfo: isPersonalInfo,
  techStackGroups: isTechStackGroups,
  projects: isProjects,
  blogPosts: isBlogPosts,
  siteSettings: isSiteSettings,
  homePage: isHomePage,
  showcasePage: isShowcasePage,
  blogPage: isBlogPage,
  aboutPage: isAboutPage,
  agentPage: isAgentPage,
  musicPlayer: isMusicPlayer,
};

export function isRemoteSiteContent(value: unknown): value is RemoteSiteContent {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, fieldValue]) => (
    Object.prototype.hasOwnProperty.call(TOP_LEVEL_VALIDATORS, key)
    && TOP_LEVEL_VALIDATORS[key as keyof SiteContent](fieldValue)
  ));
}

export function isSiteContent(value: unknown): value is SiteContent {
  if (!isRemoteSiteContent(value)) return false;
  return (Object.keys(TOP_LEVEL_VALIDATORS) as Array<keyof SiteContent>)
    .every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
