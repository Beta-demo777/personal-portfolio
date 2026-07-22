export interface Project {
  id: string;
  title: string;
  description: string;
  longDescription?: string;
  tags: string[];
  url?: string;
  github?: string;
  stats: {
    stars?: number;
    forks?: number;
    impact?: string;
  };
  featured: boolean;
  role: string;
  year: string;
}

export interface BlogPost {
  id: string;
  title: string;
  slug?: string;
  excerpt: string;
  content: string; // Markdown or rich text
  /** ISO-8601 full-date in YYYY-MM-DD form. */
  date: string;
  readTime: string;
  category: string;
  tags: string[];
  views: number;
  likes: number;
  status: 'draft' | 'published';
  coverImage?: string;
  seoTitle?: string;
  seoDescription?: string;
  /** ISO-8601 timestamp with a timezone. */
  scheduledAt?: string;
}

export interface TechStackGroup {
  id: string;
  title: string;
  items: string[];
}

export type PageId = 'home' | 'showcase' | 'blog' | 'agent' | 'about';

export interface NavigationItem {
  id: PageId;
  label: string;
}

export interface HighlightCard {
  id: string;
  title: string;
  description: string;
  icon: 'code' | 'layers' | 'sparkles';
}

export interface HomePageContent {
  greetings: string[];
  heroPrefix: string;
  heroHighlight: string;
  heroSuffix: string;
  introduction: string;
  highlights: HighlightCard[];
  portfolioButton: string;
  agentButton: string;
  blogButton: string;
}

export interface ShowcasePageContent {
  identityLabel: string;
  terminalWelcome: string;
  terminalHint: string;
  terminalTitle: string;
  terminalPlaceholder: string;
  technologyTitle: string;
  worksEyebrow: string;
  worksTitle: string;
  terminalPrompt: string;
  quickLabel: string;
  allFilterLabel: string;
  terminalHelp: string[];
  commandNotFound: string;
  detailsLabel: string;
  repositoryLabel: string;
  livePreviewLabel: string;
  impactLabel: string;
  starsLabel: string;
  forksLabel: string;
}

export interface BlogPageContent {
  eyebrow: string;
  title: string;
  description: string;
  searchPlaceholder: string;
  noResultsText: string;
  backLabel: string;
  relatedTitle: string;
  allCategoryLabel: string;
  readsLabel: string;
  likeLabel: string;
  linkCopiedLabel: string;
}

export interface HobbyItem {
  id: string;
  title: string;
  description: string;
  icon: 'coffee' | 'code' | 'game' | 'screen';
}

export interface AboutPageContent {
  eyebrow: string;
  title: string;
  description: string;
  introductionTitle: string;
  introduction: string[];
  experienceTitle: string;
  hobbiesTitle: string;
  hobbies: HobbyItem[];
  technologyTitle: string;
  contactEyebrow: string;
  contactTitle: string;
  contactDescription: string;
  contactNamePlaceholder: string;
  contactMessagePlaceholder: string;
  contactSendingLabel: string;
  contactSuccessLabel: string;
  contactSubmitLabel: string;
}

export interface AgentPrompt {
  label: string;
  text: string;
}

export interface AgentPageContent {
  title: string;
  description: string;
  welcomeMessage: string;
  initialBubble: string;
  loadingBubble: string;
  answeredBubble: string;
  resetBubble: string;
  inputPlaceholder: string;
  displayName: string;
  badgeLabel: string;
  modelLabel: string;
  idleStatus: string;
  loadingStatus: string;
  interactionHint: string;
  suggestionsTitle: string;
  resetLabel: string;
  samplePrompts: AgentPrompt[];
  funQuotes: string[];
}

export interface Soundscape {
  id: string;
  name: string;
  description: string;
  type: 'synth' | 'noise';
  frequency: number;
}

export interface MusicPlayerContent {
  title: string;
  minimizedLabel: string;
  standbyLabel: string;
  playingPrefix: string;
  tracks: Soundscape[];
}

export interface SiteSettings {
  siteTitle: string;
  siteDescription: string;
  brandInitials: string;
  navigation: NavigationItem[];
  footerCopyright: string;
  footerBadges: string[];
  icpNumber: string;
  icpUrl: string;
}

export interface TerminalCommand {
  command: string;
  description: string;
  output: string | string[];
}
