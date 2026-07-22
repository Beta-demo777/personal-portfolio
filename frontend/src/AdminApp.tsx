import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  BadgeInfo,
  Bot,
  Bold,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleUserRound,
  Cloud,
  Code2,
  Command,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  FolderKanban,
  Globe2,
  Heading2,
  History,
  House,
  ImagePlus,
  Images,
  Italic,
  Layers3,
  LayoutDashboard,
  Link2,
  List,
  ListChecks,
  ListTree,
  LoaderCircle,
  LogOut,
  Maximize2,
  Menu,
  MoreHorizontal,
  Music2,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createDraftBlogPost, DEFAULT_SITE_CONTENT, normalizeSiteContent, type SiteContent } from './content';
import type { BlogPost, PageId, Project } from './types';
import {
  ADMIN_API_ERROR_CODES,
  AdminAuthUnavailableState,
  AdminContentLoadState,
  AdminNoticeToast,
  adminApi,
  CommandPalette,
  ConfirmDialog,
  describeAdminApiError,
  InlineResourceState,
  isAdminApiError,
  isAdminApiErrorCode,
  MediaPickerDialog,
  ResponsivePreview,
  beginResourceLoad,
  completeResourceLoad,
  failResourceLoad,
  IDLE_RESOURCE_STATE,
  mergeSiteContentVersions,
  type AdminMediaItem,
  type AdminNotice,
  type AdminRevisionSummary,
  type CommandPaletteAction,
  type MediaPickerSelection,
  type ResourceState,
} from './admin';
import {
  ADMIN_DRAFT_SCHEMA_VERSION,
  readAdminDraft,
  removeAdminDraft,
  removeAdminDraftSources,
  removeLegacyAdminDraft,
  writeAdminDraft,
  type AdminDraft,
  type AdminDraftLease,
  type CurrentAdminDraft,
} from './admin/draftStorage';
import { useModalA11y } from './admin/useModalA11y';
import { useAdminEditorLock } from './admin/useAdminEditorLock';
import {
  readStorageValue,
  writeStorageValue,
} from './admin/storage';
import {
  countArticleText,
  fromDatetimeLocalValue,
  getMarkdownOutline,
  getPostPublishChecks,
  slugifyPostTitle,
  toDatetimeLocalValue,
} from './admin/blogPostUtils';
import MarkdownRenderer from './components/MarkdownRenderer';
import { findBlogPostRouteKeyConflict, isRouteSafeKey } from './routing';

type SectionKey = keyof SiteContent;
type AdminSectionKey = 'overview' | 'media' | SectionKey;

type MediaItem = AdminMediaItem;
type RevisionSummary = AdminRevisionSummary;

interface PendingConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'warning' | 'primary';
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface SaveOptions {
  successMessage?: string;
  allowPublishWarnings?: boolean;
  closePostSettingsOnSuccess?: boolean;
}

interface SaveConflict {
  baseEtag: string;
  baseContent: SiteContent;
  localContent: SiteContent;
  detectedAt: string;
  serverEtag: string | null;
  serverContent: SiteContent | null;
  serverResolution: SiteContent | null;
  localResolution: SiteContent | null;
  conflicts: string[];
  resolution: 'server' | 'local' | null;
}

type ContentLoadState = 'idle' | 'loading' | 'ready' | 'error';

interface NavigationEntry {
  key: AdminSectionKey;
  label: string;
  description: string;
  icon: LucideIcon;
}

const navigationGroups: Array<{ label: string; items: NavigationEntry[] }> = [
  {
    label: '工作台',
    items: [
      { key: 'overview', label: '控制台', description: '内容概览与快捷入口', icon: LayoutDashboard },
    ],
  },
  {
    label: '内容',
    items: [
      { key: 'blogPosts', label: '博客文章', description: '写作、草稿与发布', icon: FileText },
      { key: 'projects', label: '作品项目', description: '项目案例与数据', icon: FolderKanban },
      { key: 'media', label: '媒体资源库', description: '上传、复用与管理图片', icon: Images },
    ],
  },
  {
    label: '页面',
    items: [
      { key: 'homePage', label: '首页内容', description: '首屏、亮点与按钮', icon: House },
      { key: 'showcasePage', label: '作品集页面', description: '终端与页面文案', icon: PanelTop },
      { key: 'blogPage', label: '博客页面', description: '列表与阅读页文案', icon: Newspaper },
      { key: 'aboutPage', label: '关于页面', description: '介绍、兴趣与联系', icon: BadgeInfo },
      { key: 'agentPage', label: '智能体页面', description: '欢迎语与快捷问题', icon: Bot },
    ],
  },
  {
    label: '站点',
    items: [
      { key: 'siteSettings', label: '全局设置', description: '品牌、导航与页脚', icon: Settings2 },
      { key: 'personalInfo', label: '个人资料', description: '身份与工作经历', icon: CircleUserRound },
      { key: 'techStackGroups', label: '技术栈', description: '技术分类与能力项', icon: Layers3 },
      { key: 'musicPlayer', label: '音乐播放器', description: '音轨与播放器文案', icon: Music2 },
    ],
  },
];

const allNavigationEntries = navigationGroups.flatMap((group) => group.items);

const showcaseFields = [
  ['identityLabel', '身份标签'],
  ['terminalWelcome', '终端欢迎语'],
  ['terminalHint', '终端提示语'],
  ['terminalTitle', '终端标题'],
  ['terminalPlaceholder', '终端输入提示'],
  ['technologyTitle', '技术矩阵标题'],
  ['worksEyebrow', '作品集眉题'],
  ['worksTitle', '作品集标题'],
  ['terminalPrompt', '终端命令提示符'],
  ['quickLabel', '快捷命令标签'],
  ['allFilterLabel', '全部筛选标签'],
  ['commandNotFound', '未知命令提示'],
  ['detailsLabel', '查看详情文案'],
  ['repositoryLabel', '仓库按钮文案'],
  ['livePreviewLabel', '预览按钮文案'],
  ['impactLabel', '影响指标标签'],
  ['starsLabel', 'Stars 标签'],
  ['forksLabel', 'Forks 标签'],
] as const;

const blogPageFields = [
  ['eyebrow', '页面眉题'],
  ['title', '页面标题'],
  ['description', '页面描述'],
  ['searchPlaceholder', '搜索框提示'],
  ['noResultsText', '无结果提示'],
  ['backLabel', '返回按钮文案'],
  ['relatedTitle', '相关文章标题'],
  ['allCategoryLabel', '全部分类标签'],
  ['readsLabel', '阅读量单位'],
  ['likeLabel', '点赞按钮文案'],
  ['linkCopiedLabel', '链接复制成功提示'],
] as const;

const aboutPageFields = [
  ['eyebrow', '页面眉题'],
  ['title', '页面标题'],
  ['description', '页面描述'],
  ['introductionTitle', '自我介绍标题'],
  ['experienceTitle', '工作经历标题'],
  ['hobbiesTitle', '兴趣板块标题'],
  ['technologyTitle', '技术栈标题'],
  ['contactEyebrow', '联系板块眉题'],
  ['contactTitle', '联系板块标题'],
  ['contactDescription', '联系板块描述'],
  ['contactNamePlaceholder', '称呼输入框提示'],
  ['contactMessagePlaceholder', '消息输入框提示'],
  ['contactSendingLabel', '发送中提示'],
  ['contactSuccessLabel', '发送成功提示'],
  ['contactSubmitLabel', '发送按钮文案'],
] as const;

const agentPageFields = [
  ['title', '页面标题'],
  ['description', '页面描述'],
  ['welcomeMessage', '首次欢迎消息'],
  ['initialBubble', '初始气泡文案'],
  ['loadingBubble', '思考中气泡文案'],
  ['answeredBubble', '回答完成气泡文案'],
  ['resetBubble', '重置气泡文案'],
  ['inputPlaceholder', '输入框提示'],
  ['displayName', '智能体显示名'],
  ['badgeLabel', '智能体徽章'],
  ['modelLabel', '模型说明'],
  ['idleStatus', '待机状态文案'],
  ['loadingStatus', '思考状态文案'],
  ['interactionHint', '数字人互动提示'],
  ['suggestionsTitle', '快捷问题标题'],
  ['resetLabel', '重置按钮文案'],
] as const;

const inputClass = 'min-h-11 w-full rounded-lg border border-white/[0.1] bg-[#090b11] px-3.5 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 hover:border-white/[0.16] focus:border-indigo-400/70 focus:ring-2 focus:ring-indigo-500/15';
const labelClass = 'space-y-1.5 text-xs font-medium text-zinc-300';
const SIDEBAR_STORAGE_KEY = 'portfolio-admin-sidebar-collapsed';

function normalizeContent(content: SiteContent): SiteContent {
  return normalizeSiteContent(content);
}

function createCurrentAdminDraft(
  baseEtag: string,
  baseContent: SiteContent,
  content: SiteContent,
  savedAt = new Date().toISOString(),
): CurrentAdminDraft {
  return {
    kind: 'current',
    schemaVersion: ADMIN_DRAFT_SCHEMA_VERSION,
    baseEtag,
    baseContent: structuredClone(baseContent),
    content: structuredClone(content),
    savedAt,
  };
}

function adminErrorStringList(error: unknown, key: string): string[] {
  if (!isAdminApiError(error)) return [];
  const value = error.details?.[key];
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  value.forEach((item) => {
    if (unique.size >= 20 || typeof item !== 'string') return;
    const normalized = item.trim();
    if (normalized.length > 0 && normalized.length <= 256) unique.add(normalized);
  });
  return Array.from(unique);
}

function summarizeStringList(items: string[], visibleItems = 5): string {
  const shown = items.slice(0, visibleItems).join('、');
  return items.length > visibleItems ? `${shown} 等 ${items.length} 项` : shown;
}

function findContentReferencePaths(
  value: unknown,
  filenames: ReadonlySet<string>,
  path = '$',
  results: string[] = [],
): string[] {
  if (results.length >= 20) return results;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findContentReferencePaths(item, filenames, `${path}[${index}]`, results));
  } else if (typeof value === 'object' && value !== null) {
    Object.entries(value).forEach(([key, item]) => findContentReferencePaths(item, filenames, `${path}.${key}`, results));
  } else if (typeof value === 'string' && Array.from(filenames).some((filename) => value.includes(filename))) {
    results.push(path);
  }
  return results;
}

function estimateReadTime(markdown: string) {
  const chineseCharacters = markdown.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinWords = markdown
    .replace(/[`#>*_\-[\]()]/g, ' ')
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word)).length;
  const minutes = Math.max(1, Math.ceil(chineseCharacters / 300 + latinWords / 200));
  return `${minutes} min read`;
}

function isValidScheduledAt(value?: string) {
  if (!value?.trim()) return true;
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim()) && !Number.isNaN(new Date(value).getTime());
}

function measureTextareaCaretTop(editor: HTMLTextAreaElement, value: string, offset: number) {
  const computed = window.getComputedStyle(editor);
  const mirror = document.createElement('div');
  mirror.style.position = 'fixed';
  mirror.style.left = '-10000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.boxSizing = computed.boxSizing;
  mirror.style.width = `${editor.offsetWidth}px`;
  mirror.style.padding = computed.padding;
  mirror.style.border = computed.border;
  mirror.style.font = computed.font;
  mirror.style.letterSpacing = computed.letterSpacing;
  mirror.style.lineHeight = computed.lineHeight;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={labelClass}><span className="block">{label}</span>{children}</label>;
}

function EmptyList({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-white/10 p-7 text-center text-sm text-zinc-500">{children}</p>;
}

function MarkdownPreview({ content }: { content: string }) {
  return <MarkdownRenderer content={content} className="text-xs leading-relaxed" />;
}

export default function AdminApp() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authStatusError, setAuthStatusError] = useState('');
  const [contentLoadState, setContentLoadState] = useState<ContentLoadState>('idle');
  const [contentLoadError, setContentLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [content, setContent] = useState<SiteContent>(normalizeContent(DEFAULT_SITE_CONTENT));
  const [activeSection, setActiveSection] = useState<AdminSectionKey>('overview');
  const [selectedProject, setSelectedProject] = useState(0);
  const [selectedPost, setSelectedPost] = useState(0);
  const [notice, setNotice] = useState<AdminNotice | null>(null);
  const [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null);
  const [conflictResolving, setConflictResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = readStorageValue(SIDEBAR_STORAGE_KEY);
    return stored.ok && stored.value === 'true';
  });
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(normalizeContent(DEFAULT_SITE_CONTENT)));
  const [contentVersion, setContentVersion] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [localDraft, setLocalDraft] = useState<AdminDraft | null>(null);
  const [draftChoiceResolving, setDraftChoiceResolving] = useState(false);
  const [autoBackupAt, setAutoBackupAt] = useState<Date | null>(null);
  const [autoBackupUnavailable, setAutoBackupUnavailable] = useState(false);
  const [postSearch, setPostSearch] = useState('');
  const [postStatusFilter, setPostStatusFilter] = useState<'all' | 'draft' | 'published'>('all');
  const [postSort, setPostSort] = useState<'newest' | 'oldest' | 'title'>('newest');
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(() => new Set());
  const [postSelectionMode, setPostSelectionMode] = useState(false);
  const [postToolbarMenuOpen, setPostToolbarMenuOpen] = useState(false);
  const [postOutlineOpen, setPostOutlineOpen] = useState(false);
  const [postTagDraft, setPostTagDraft] = useState('');
  const [desktopSidebar, setDesktopSidebar] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [widePostSettings, setWidePostSettings] = useState(() => window.matchMedia('(min-width: 1600px)').matches);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<'all' | 'featured' | 'standard'>('all');
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaSearch, setMediaSearch] = useState('');
  const [mediaState, setMediaState] = useState<ResourceState>(IDLE_RESOURCE_STATE);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [revisionsState, setRevisionsState] = useState<ResourceState>(IDLE_RESOURCE_STATE);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [editorFocusMode, setEditorFocusMode] = useState(false);
  const [postEditorOpen, setPostEditorOpen] = useState(false);
  const [postEditorView, setPostEditorView] = useState<'write' | 'split' | 'preview'>('write');
  const [postSettingsOpen, setPostSettingsOpen] = useState(false);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const {
    status: editorLockStatus,
    lease: editorLease,
    isCurrentLease,
    rotateLease: rotateEditorLease,
  } = useAdminEditorLock(authenticated === true);
  const markdownEditorRef = useRef<HTMLTextAreaElement>(null);
  const focusMarkdownEditorRef = useRef<HTMLTextAreaElement>(null);
  const postToolbarMenuRef = useRef<HTMLDivElement>(null);
  const postToolbarMenuButtonRef = useRef<HTMLButtonElement>(null);
  const postOutlineRef = useRef<HTMLDivElement>(null);
  const postOutlineButtonRef = useRef<HTMLButtonElement>(null);
  const revisionsPanelRef = useRef<HTMLElement>(null);
  const revisionsCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarPanelRef = useRef<HTMLElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const focusEditorPanelRef = useRef<HTMLElement>(null);
  const focusEditorCloseRef = useRef<HTMLButtonElement>(null);
  const postSettingsPanelRef = useRef<HTMLElement>(null);
  const postSettingsCloseRef = useRef<HTMLButtonElement>(null);
  const mediaRequestIdRef = useRef(0);
  const revisionsRequestIdRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const saveOperationIdRef = useRef(0);
  const conflictOperationIdRef = useRef(0);
  const draftChoiceResolvingRef = useRef(false);
  const endingSessionRef = useRef(false);
  const activeSaveOperationRef = useRef<{
    id: number;
    lease: AdminDraftLease;
    controller: AbortController | null;
  } | null>(null);
  const draftEpochRef = useRef(0);
  const contentSnapshot = useMemo(() => JSON.stringify(content), [content]);
  const contentSnapshotRef = useRef(contentSnapshot);
  const contentRef = useRef(content);
  const contentVersionRef = useRef(contentVersion);
  const baseContentRef = useRef<SiteContent>(normalizeContent(DEFAULT_SITE_CONTENT));
  const savedSnapshotRef = useRef(savedSnapshot);
  const localDraftRef = useRef(localDraft);
  const saveConflictRef = useRef(saveConflict);
  const saveBlockedByConflictRef = useRef(false);
  const saveBlockedRef = useRef(false);
  contentSnapshotRef.current = contentSnapshot;
  contentRef.current = content;
  contentVersionRef.current = contentVersion;
  savedSnapshotRef.current = savedSnapshot;
  localDraftRef.current = localDraft;
  saveConflictRef.current = saveConflict;
  const isDirty = contentSnapshot !== savedSnapshot;
  const saveBlockedByConflict = Boolean(saveConflict && (
    !saveConflict.serverContent
    || (saveConflict.conflicts.length > 0 && saveConflict.resolution === null)
  ));
  const saveBlockedByDraftChoice = localDraft !== null;
  const saveBlockedByEditorLock = editorLockStatus !== 'held';
  saveBlockedByConflictRef.current = saveBlockedByConflict;
  const saveBlocked = saveBlockedByConflict
    || saveBlockedByDraftChoice
    || saveBlockedByEditorLock
    || endingSession;
  saveBlockedRef.current = saveBlocked;
  const changedSections = useMemo(() => {
    try {
      const savedContent = JSON.parse(savedSnapshot) as SiteContent;
      return (Object.keys(content) as SectionKey[]).filter(
        (key) => JSON.stringify(content[key]) !== JSON.stringify(savedContent[key]),
      );
    } catch {
      return [];
    }
  }, [content, savedSnapshot]);
  const activeNavigation = allNavigationEntries.find((entry) => entry.key === activeSection) || allNavigationEntries[0];
  const sidebarIsModal = sidebarOpen && !desktopSidebar;
  const postSettingsIsModal = activeSection === 'blogPosts' && postSettingsOpen && !widePostSettings && !confirmation;
  const notify = useCallback((tone: AdminNotice['tone'], code: string, message: string) => {
    setNotice({ tone, code, message });
  }, []);
  const closeTransientAdminUi = useCallback(() => {
    setCommandPaletteOpen(false);
    setMediaPickerOpen(false);
    setRevisionsOpen(false);
    setPreviewOpen(false);
    setEditorFocusMode(false);
    setPostSettingsOpen(false);
    setPostToolbarMenuOpen(false);
    setPostOutlineOpen(false);
    setPostEditorOpen(false);
    setSidebarOpen(false);
    setConfirmation(null);
  }, []);
  const captureEditorLease = useCallback((): AdminDraftLease | null => (
    isCurrentLease(editorLease) ? editorLease : null
  ), [editorLease, isCurrentLease]);
  const flushCurrentDraft = useCallback(async (): Promise<boolean> => {
    const currentConflict = saveConflictRef.current;
    if (localDraftRef.current) return true;
    if (contentSnapshotRef.current === savedSnapshotRef.current && !currentConflict) return true;
    const lease = captureEditorLease();
    const currentVersion = contentVersionRef.current;
    if (!lease || !currentVersion) return false;

    const savedAt = new Date().toISOString();
    const backupRecord = currentConflict && saveBlockedByConflictRef.current
      ? createCurrentAdminDraft(
        currentConflict.baseEtag,
        currentConflict.baseContent,
        currentConflict.serverContent ? currentConflict.localContent : contentRef.current,
        savedAt,
      )
      : createCurrentAdminDraft(
        currentVersion,
        baseContentRef.current,
        contentRef.current,
        savedAt,
      );
    try {
      const backup = await writeAdminDraft(backupRecord, lease);
      if (!backup.ok || !isCurrentLease(lease)) return false;
      setAutoBackupAt(new Date(savedAt));
      setAutoBackupUnavailable(false);
      return true;
    } catch {
      return false;
    }
  }, [captureEditorLease, isCurrentLease]);
  const expireAdminSession = useCallback(async (): Promise<boolean> => {
    if (endingSessionRef.current) return false;
    endingSessionRef.current = true;
    saveBlockedRef.current = true;
    mediaRequestIdRef.current += 1;
    revisionsRequestIdRef.current += 1;
    closeTransientAdminUi();
    setEndingSession(true);
    draftEpochRef.current += 1;
    try {
      if (!await flushCurrentDraft()) {
        setAutoBackupUnavailable(true);
        notify(
          'error',
          'SESSION_DRAFT_BACKUP_FAILED',
          '会话已经失效，但当前更改无法安全写入浏览器备份。页面内容仍保留，请恢复浏览器存储后重试，暂时不要关闭页面。',
        );
        return false;
      }
      setAuthenticated(false);
      setContentLoadState('idle');
      setContentLoadError('');
      return true;
    } finally {
      endingSessionRef.current = false;
      setEndingSession(false);
    }
  }, [closeTransientAdminUi, flushCurrentDraft, notify]);

  useEffect(() => {
    if (isCurrentLease(editorLease)) return;
    activeSaveOperationRef.current?.controller?.abort();
  }, [editorLease, isCurrentLease]);

  useEffect(() => {
    if (!saveBlocked) return;
    setCommandPaletteOpen(false);
    setMediaPickerOpen(false);
    setRevisionsOpen(false);
  }, [saveBlocked]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const handleChange = (event: MediaQueryListEvent) => {
      setDesktopSidebar(event.matches);
      if (event.matches) setSidebarOpen(false);
    };
    setDesktopSidebar(query.matches);
    if (query.matches) setSidebarOpen(false);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1600px)');
    const handleChange = (event: MediaQueryListEvent) => {
      setWidePostSettings(event.matches);
      if (event.matches) setPostSettingsOpen(false);
    };
    setWidePostSettings(query.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const normalizeEditorView = (matches: boolean) => {
      if (matches) setPostEditorView((current) => current === 'split' ? 'write' : current);
    };
    const handleChange = (event: MediaQueryListEvent) => normalizeEditorView(event.matches);
    normalizeEditorView(query.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!postToolbarMenuOpen && !postOutlineOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (postToolbarMenuOpen && !postToolbarMenuRef.current?.contains(target)) setPostToolbarMenuOpen(false);
      if (postOutlineOpen && !postOutlineRef.current?.contains(target)) setPostOutlineOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const outlineWasOpen = postOutlineOpen;
      setPostToolbarMenuOpen(false);
      setPostOutlineOpen(false);
      if (outlineWasOpen) postOutlineButtonRef.current?.focus();
      else postToolbarMenuButtonRef.current?.focus();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [postOutlineOpen, postToolbarMenuOpen]);

  useEffect(() => {
    setPostTagDraft('');
    setPostToolbarMenuOpen(false);
    setPostOutlineOpen(false);
  }, [selectedPost]);

  useEffect(() => {
    setSelectedPostIds(new Set());
  }, [postSearch, postStatusFilter]);

  useEffect(() => {
    const editor = markdownEditorRef.current;
    if (!editor) return;
    const resizeEditor = () => {
      editor.style.height = 'auto';
      editor.style.height = `${Math.max(580, editor.scrollHeight)}px`;
    };
    resizeEditor();
    const observer = new ResizeObserver(resizeEditor);
    if (editor.parentElement) observer.observe(editor.parentElement);
    return () => observer.disconnect();
  }, [content.blogPosts[selectedPost]?.content, postEditorView]);

  const loadContent = useCallback(async (): Promise<boolean> => {
    const lease = captureEditorLease();
    if (!lease) return false;
    draftEpochRef.current += 1;
    setContentLoadState('loading');
    setContentLoadError('');
    try {
      const result = await adminApi.readContent();
      if (!isCurrentLease(lease)) return false;
      const serverContent = result.initialized
        ? normalizeContent(result.content)
        : normalizeContent(DEFAULT_SITE_CONTENT);
      const serverSnapshot = JSON.stringify(serverContent);
      setContentVersion(result.etag);
      contentVersionRef.current = result.etag;
      baseContentRef.current = structuredClone(serverContent);
      contentRef.current = serverContent;
      contentSnapshotRef.current = serverSnapshot;
      setContent(serverContent);
      setSavedSnapshot(serverSnapshot);
      setSaveConflict(null);
      setLocalDraft(null);
      setAutoBackupAt(null);
      const finishLoad = () => {
        setContentLoadState('ready');
        return true;
      };

      const storedDraft = await readAdminDraft();
      if (!isCurrentLease(lease)) return false;
      if (!storedDraft.ok) {
        const removed = storedDraft.code === 'invalid-data' && storedDraft.invalidSources?.length
          ? await removeAdminDraftSources(storedDraft.invalidSources, lease)
          : null;
        if (!isCurrentLease(lease) || (removed && !removed.ok && removed.code === 'stale-owner')) return false;
        setAutoBackupUnavailable(removed ? !removed.ok : true);
        notify(
          'warning',
          'LOCAL_DRAFT_READ_FAILED',
          storedDraft.code === 'unsupported-version'
            ? '浏览器中存在由较新版本后台创建的草稿，当前版本无法安全读取，已原样保留且不会覆盖。请使用较新版本后台处理该草稿。'
            : storedDraft.code === 'invalid-data'
            ? removed?.ok
              ? '检测到无法识别的本地草稿，已只清理损坏的存储来源；服务器内容未受影响。'
              : '检测到无法识别的本地草稿，但浏览器未能清理损坏的存储来源；服务器内容未受影响。'
            : '无法读取浏览器中的本地草稿；服务器内容已加载，但关闭页面前请及时手动保存。',
        );
        const indexedDbReadIsUnsafe = storedDraft.source === 'indexeddb'
          && (storedDraft.code !== 'invalid-data' || !removed?.ok);
        if (storedDraft.code === 'unsupported-version' || indexedDbReadIsUnsafe) {
          setContentLoadError(
            storedDraft.code === 'unsupported-version'
              ? '浏览器中存在当前版本无法安全处理的较新草稿。为避免覆盖该草稿，编辑器已停止载入。'
              : storedDraft.code === 'invalid-data'
                ? '浏览器中的损坏草稿无法安全隔离。为避免覆盖仍可能恢复的数据，编辑器已停止载入。'
                : '无法确认浏览器中是否存在未保存草稿。为避免覆盖未知数据，编辑器已停止载入，请恢复浏览器存储访问后重试。',
          );
          setContentLoadState('error');
          return false;
        }
        return finishLoad();
      }

      let invalidSourceCleanupFailed = false;
      if (storedDraft.invalidSources?.length) {
        const removed = await removeAdminDraftSources(storedDraft.invalidSources, lease);
        if (!isCurrentLease(lease) || (!removed.ok && removed.code === 'stale-owner')) return false;
        invalidSourceCleanupFailed = !removed.ok;
        notify(
          'warning',
          removed.ok ? 'LOCAL_DRAFT_INVALID_SOURCE_REMOVED' : 'LOCAL_DRAFT_INVALID_SOURCE_RETAINED',
          removed.ok
            ? '检测到损坏的 IndexedDB 草稿，已仅隔离该记录，并继续使用验证通过的旧版本地备份。'
            : '检测到损坏的 IndexedDB 草稿；旧版本地备份已验证并保留，但损坏记录未能清理。',
        );
        if (invalidSourceCleanupFailed) {
          setAutoBackupUnavailable(true);
          setContentLoadError(
            '浏览器中的损坏草稿无法安全隔离。为避免覆盖仍可能恢复的数据，编辑器已停止载入。',
          );
          setContentLoadState('error');
          return false;
        }
      }

      const draft = storedDraft.value;
      if (!draft) {
        setAutoBackupUnavailable(false);
        return finishLoad();
      }

      const draftContent = normalizeSiteContent(draft.content);
      if (JSON.stringify(draftContent) === serverSnapshot) {
        const removed = draft.kind === 'legacy'
          ? await removeLegacyAdminDraft(lease)
          : await removeAdminDraft(lease);
        if (!isCurrentLease(lease) || (!removed.ok && removed.code === 'stale-owner')) return false;
        setAutoBackupUnavailable(!removed.ok);
        if (!removed.ok) {
          notify('warning', 'LOCAL_DRAFT_CLEANUP_FAILED', '本地草稿与服务器内容相同，但浏览器未能清理旧备份。');
        }
        return finishLoad();
      }

      if (draft.kind === 'legacy') {
        setLocalDraft({ ...draft, content: draftContent });
        setAutoBackupAt(new Date(draft.savedAt));
        setAutoBackupUnavailable(false);
        return finishLoad();
      }

      const draftBase = normalizeSiteContent(draft.baseContent);
      const baseMatchesServer = JSON.stringify(draftBase) === serverSnapshot;
      if (draft.baseEtag === result.etag && baseMatchesServer) {
        contentRef.current = draftContent;
        contentSnapshotRef.current = JSON.stringify(draftContent);
        setContent(draftContent);
        setAutoBackupAt(new Date(draft.savedAt));
        setAutoBackupUnavailable(false);
        notify('info', 'LOCAL_DRAFT_RESTORED', '已自动恢复基于当前服务器版本的本地草稿。');
        return finishLoad();
      }

      if (draft.baseEtag === result.etag) {
        setLocalDraft({ ...draft, baseContent: draftBase, content: draftContent });
        setAutoBackupAt(new Date(draft.savedAt));
        setAutoBackupUnavailable(false);
        notify('warning', 'LOCAL_DRAFT_BASE_MISMATCH', '本地草稿的基础内容与服务器版本不一致，请明确选择保留整个服务器版本或整个本地草稿。');
        return finishLoad();
      }

      const merged = mergeSiteContentVersions(draftBase, draftContent, serverContent);
      contentRef.current = merged.content;
      contentSnapshotRef.current = JSON.stringify(merged.content);
      setContent(merged.content);
      setSelectedPostIds(new Set());
      setSelectedProjectIds(new Set());
      setSelectedPost(0);
      setSelectedProject(0);

      if (merged.conflicts.length === 0) {
        const rebasedAt = new Date().toISOString();
        const backup = await writeAdminDraft(createCurrentAdminDraft(
          result.etag,
          serverContent,
          merged.content,
          rebasedAt,
        ), lease);
        if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return false;
        setAutoBackupAt(backup.ok ? new Date(rebasedAt) : new Date(draft.savedAt));
        setAutoBackupUnavailable(!backup.ok);
        notify(
          backup.ok ? 'info' : 'warning',
          backup.ok ? 'LOCAL_DRAFT_AUTO_MERGED' : 'LOCAL_DRAFT_REBASE_FAILED',
          backup.ok
            ? '服务器更新与本地草稿没有同字段冲突，已自动合并；确认后请手动保存。'
            : '服务器更新与本地草稿已在当前页面合并，但无法更新浏览器备份，请勿关闭页面。',
        );
        return finishLoad();
      }

      setSaveConflict({
        baseEtag: draft.baseEtag,
        baseContent: structuredClone(draftBase),
        localContent: structuredClone(draftContent),
        detectedAt: draft.savedAt,
        serverEtag: result.etag,
        serverContent: structuredClone(serverContent),
        serverResolution: structuredClone(merged.content),
        localResolution: structuredClone(merged.localResolution),
        conflicts: merged.conflicts,
        resolution: null,
      });
      setAutoBackupAt(new Date(draft.savedAt));
      setAutoBackupUnavailable(false);
      notify(
        'warning',
        'LOCAL_DRAFT_CONFLICT',
        `本地草稿与服务器版本有 ${merged.conflicts.length} 个同字段冲突；保存前必须明确选择冲突字段采用哪一方。`,
      );
      return finishLoad();
    } catch (error) {
      if (!isCurrentLease(lease)) return false;
      if (isAdminApiError(error, 'unauthorized')) {
        if (await expireAdminSession()) {
          notify('error', 'SESSION_EXPIRED', describeAdminApiError(error, '无法读取后台内容'));
        }
        return false;
      }
      const message = describeAdminApiError(error, '无法读取后台内容');
      setContentLoadError(message);
      setContentLoadState('error');
      return false;
    }
  }, [captureEditorLease, expireAdminSession, isCurrentLease, notify]);

  const checkAuthentication = useCallback(async () => {
    setAuthenticated(null);
    setAuthStatusError('');
    try {
      const sessionAuthenticated = await adminApi.status();
      if (sessionAuthenticated) {
        setAuthenticated(true);
        return;
      }
      setAuthenticated(false);
    } catch (error) {
      if (isAdminApiError(error, 'unauthorized') || isAdminApiError(error, 'forbidden')) {
        setAuthenticated(false);
        setContentLoadState('idle');
        setContentLoadError('');
        return;
      }
      setAuthStatusError(describeAdminApiError(error, '无法检查登录状态'));
    }
  }, []);

  useEffect(() => {
    void checkAuthentication();
  }, [checkAuthentication]);

  useEffect(() => {
    if (authenticated === true && editorLockStatus === 'held' && contentLoadState === 'idle') {
      void loadContent();
    }
  }, [authenticated, contentLoadState, editorLockStatus, loadContent]);

  useEffect(() => {
    writeStorageValue(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!isDirty && !saveConflict) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isDirty, saveConflict]);

  useModalA11y({
    active: revisionsOpen,
    containerRef: revisionsPanelRef,
    initialFocusRef: revisionsCloseRef,
    onClose: () => setRevisionsOpen(false),
  });

  useModalA11y({
    active: sidebarIsModal,
    containerRef: sidebarPanelRef,
    initialFocusRef: sidebarCloseRef,
    onClose: () => setSidebarOpen(false),
  });

  useModalA11y({
    active: editorFocusMode,
    containerRef: focusEditorPanelRef,
    initialFocusRef: focusMarkdownEditorRef,
    onClose: () => setEditorFocusMode(false),
  });

  useModalA11y({
    active: postSettingsIsModal,
    containerRef: postSettingsPanelRef,
    initialFocusRef: postSettingsCloseRef,
    onClose: () => setPostSettingsOpen(false),
  });

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setLoggingIn(true);
    try {
      const loginSucceeded = await adminApi.login(password);
      if (!loginSucceeded) {
        notify('error', 'AUTH_INVALID_RESPONSE', '后台没有确认登录成功，请重试');
        return;
      }
      setAuthenticated(true);
      setAuthStatusError('');
      setContentLoadState('idle');
      setContentLoadError('');
      setNotice(null);
      setPassword('');
    } catch (error) {
      const serverMessage = isAdminApiError(error) && error.status === 503
        ? '后台认证服务尚未配置，请检查服务设置'
        : '后台服务暂时不可用，请稍后重试';
      const message = describeAdminApiError(error, '登录失败', {
        unauthorized: '管理员密码错误，请重新输入',
        forbidden: '登录请求被安全策略拒绝，请刷新页面后重试',
        server: serverMessage,
      });
      const code = isAdminApiError(error, 'unauthorized')
        ? 'AUTH_INVALID'
        : isAdminApiError(error, 'rate-limited')
          ? 'AUTH_RATE_LIMITED'
          : 'AUTH_FAILED';
      notify('error', code, message);
    } finally {
      setLoggingIn(false);
    }
  };

  const save = useCallback(async function persistContent(
    nextContent: SiteContent = content,
    options: SaveOptions = {},
  ): Promise<boolean> {
    setNotice(null);
    const lease = captureEditorLease();
    if (!lease) return false;
    if (saveBlocked) {
      notify(
        'warning',
        saveBlockedByDraftChoice ? 'LOCAL_DRAFT_CHOICE_REQUIRED' : 'CONFLICT_RESOLUTION_REQUIRED',
        saveBlockedByDraftChoice
          ? '保存前必须明确选择保留整个服务器版本或采用整个本地草稿。'
          : '保存前必须先加载服务器版本，并明确选择冲突字段采用服务器值或本地值。',
      );
      return false;
    }
    if (saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    const saveOperationId = saveOperationIdRef.current + 1;
    saveOperationIdRef.current = saveOperationId;
    activeSaveOperationRef.current = {
      id: saveOperationId,
      lease,
      controller: null,
    };
    try {
      for (const [label, items] of [['文章', nextContent.blogPosts], ['项目', nextContent.projects]] as const) {
        const ids = items.map((item) => item.id);
        if (ids.some((id) => !id.trim())) throw new Error(`${label} ID 不能为空`);
        if (ids.some((id) => !isRouteSafeKey(id, 128))) {
          throw new Error(`${label} ID 只能包含字母、数字、连字符和下划线，且不能有首尾空格`);
        }
        const normalizedIds = ids.map((id) => id.toLowerCase());
        if (new Set(normalizedIds).size !== normalizedIds.length) throw new Error(`${label} ID 必须唯一（不区分大小写），请修改重复 ID 后再保存`);
      }
      const invalidSlugIndex = nextContent.blogPosts.findIndex((item) => (
        item.slug !== undefined && !isRouteSafeKey(item.slug, 200)
      ));
      if (invalidSlugIndex >= 0) {
        throw new Error('文章 Slug 只能包含字母、数字、连字符和下划线，且不能有首尾空格');
      }
      const routeKeyConflict = findBlogPostRouteKeyConflict(nextContent.blogPosts);
      if (routeKeyConflict) {
        throw new Error(`文章 ID 与 Slug 共用公开路由命名空间：“${routeKeyConflict.routeKey}”已被其他文章使用`);
      }
      const invalidScheduleIndex = nextContent.blogPosts.findIndex((item) => !isValidScheduledAt(item.scheduledAt));
      if (invalidScheduleIndex >= 0) {
        setActiveSection('blogPosts');
        setSelectedPost(invalidScheduleIndex);
        setPostEditorOpen(true);
        setPostSettingsOpen(true);
        throw new Error(`无法保存文章“${nextContent.blogPosts[invalidScheduleIndex].title || '未命名文章'}”：定时发布时间无效，请重新选择或清除`);
      }

      const blockedPostIndex = nextContent.blogPosts.findIndex((item) => (
        item.status === 'published' && getPostPublishChecks(item).blocking.length > 0
      ));
      if (blockedPostIndex >= 0) {
        const blockedPost = nextContent.blogPosts[blockedPostIndex];
        const checks = getPostPublishChecks(blockedPost).blocking.join('、');
        setActiveSection('blogPosts');
        setSelectedPost(blockedPostIndex);
        setPostEditorOpen(true);
        setPostSettingsOpen(true);
        throw new Error(`无法保存已发布文章“${blockedPost.title || '未命名文章'}”：${checks}`);
      }

      let persistedContent: SiteContent | null = null;
      try {
        persistedContent = JSON.parse(savedSnapshot) as SiteContent;
      } catch {
        persistedContent = null;
      }
      const newlyPublishedWithWarnings = nextContent.blogPosts.flatMap((item, index) => {
        if (item.status !== 'published') return [];
        const previous = persistedContent?.blogPosts.find((entry) => entry.id === item.id)
          ?? persistedContent?.blogPosts[index];
        if (previous && previous.status === 'published') return [];
        const warnings = getPostPublishChecks(item).warnings;
        return warnings.length > 0 ? [{ item, warnings }] : [];
      });
      if (newlyPublishedWithWarnings.length > 0 && !options.allowPublishWarnings) {
        const titles = newlyPublishedWithWarnings.map(({ item }) => `“${item.title || '未命名文章'}”`).join('、');
        const warnings = Array.from(new Set(newlyPublishedWithWarnings.flatMap((entry) => entry.warnings))).join('、');
        setConfirmation({
          title: newlyPublishedWithWarnings.length > 1 ? '仍要发布这些文章？' : '仍要发布这篇文章？',
          description: `${titles} 尚有以下建议项：${warnings}。这不会阻止发布，但可能影响列表展示和分享效果。`,
          confirmLabel: '仍然发布',
          tone: 'warning',
          onConfirm: async () => { await persistContent(nextContent, { ...options, allowPublishWarnings: true }); },
        });
        return false;
      }

      contentRef.current = nextContent;
      contentSnapshotRef.current = JSON.stringify(nextContent);
      setContent(nextContent);
      draftEpochRef.current += 1;
      setSaving(true);
      const requestBaseEtag = contentVersion;
      if (requestBaseEtag) {
        const requestBackupAt = new Date().toISOString();
        const requestBackup = await writeAdminDraft(createCurrentAdminDraft(
          requestBaseEtag,
          baseContentRef.current,
          nextContent,
          requestBackupAt,
        ), lease);
        if (!isCurrentLease(lease) || (!requestBackup.ok && requestBackup.code === 'stale-owner')) return false;
        setAutoBackupAt(requestBackup.ok ? new Date(requestBackupAt) : null);
        setAutoBackupUnavailable(!requestBackup.ok);
      }
      const saveAbortController = new AbortController();
      if (activeSaveOperationRef.current?.id !== saveOperationId) return false;
      activeSaveOperationRef.current.controller = saveAbortController;
      const nextEtag = await adminApi.saveContent(nextContent, requestBaseEtag, saveAbortController.signal);
      if (!isCurrentLease(lease)) return false;
      draftEpochRef.current += 1;
      const payloadSnapshot = JSON.stringify(nextContent);
      const currentSnapshot = contentSnapshotRef.current;
      setContentVersion(nextEtag);
      contentVersionRef.current = nextEtag;
      baseContentRef.current = structuredClone(nextContent);
      setSavedSnapshot(payloadSnapshot);
      setLastSavedAt(new Date());
      setLocalDraft(null);
      if (currentSnapshot === payloadSnapshot) {
        const removed = await removeAdminDraft(lease);
        if (!isCurrentLease(lease) || (!removed.ok && removed.code === 'stale-owner')) return false;
        if (contentSnapshotRef.current === payloadSnapshot) {
          setAutoBackupAt(null);
          setAutoBackupUnavailable(!removed.ok);
        } else {
          const backupSavedAt = new Date().toISOString();
          const backup = await writeAdminDraft(createCurrentAdminDraft(
            nextEtag,
            nextContent,
            contentRef.current,
            backupSavedAt,
          ), lease);
          if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return false;
          setAutoBackupAt(backup.ok ? new Date(backupSavedAt) : null);
          setAutoBackupUnavailable(!backup.ok);
        }
      } else {
        const backupSavedAt = new Date().toISOString();
        const backup = await writeAdminDraft(createCurrentAdminDraft(
          nextEtag,
          nextContent,
          contentRef.current,
          backupSavedAt,
        ), lease);
        if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return false;
        setAutoBackupAt(backup.ok ? new Date(backupSavedAt) : null);
        setAutoBackupUnavailable(!backup.ok);
      }
      if (options.closePostSettingsOnSuccess && currentSnapshot === payloadSnapshot) setPostSettingsOpen(false);
      setSaveConflict(null);
      notify('success', 'SAVE_SUCCEEDED', options.successMessage || '全部更改已保存；已发布内容刷新公开页面后生效');
      return true;
    } catch (error) {
      if (!isCurrentLease(lease) || (error instanceof DOMException && error.name === 'AbortError')) {
        return false;
      }
      if (isAdminApiError(error, 'conflict')) {
        const detectedAt = new Date().toISOString();
        const baseEtag = contentVersion;
        if (!baseEtag) {
          notify('error', 'CONFLICT_BASE_MISSING', '无法确认本地草稿所基于的服务器版本；当前页面内容仍保留，请刷新后重试。');
          return false;
        }
        const baseContent = structuredClone(baseContentRef.current);
        const localContent = structuredClone(contentRef.current);
        const backup = await writeAdminDraft(
          createCurrentAdminDraft(baseEtag, baseContent, localContent, detectedAt),
          lease,
        );
        if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return false;
        setAutoBackupAt(backup.ok ? new Date(detectedAt) : null);
        setAutoBackupUnavailable(!backup.ok);
        setSaveConflict({
          baseEtag,
          baseContent,
          localContent,
          detectedAt,
          serverEtag: null,
          serverContent: null,
          serverResolution: null,
          localResolution: null,
          conflicts: [],
          resolution: null,
        });
        setEditorFocusMode(false);
        setPostSettingsOpen(false);
        setLocalDraft(null);
        const conflictMessage = backup.ok
          ? '检测到其他会话更新。当前本地草稿已保留，请加载服务器版本并检查合并结果。'
          : '检测到其他会话更新。本地草稿仍保留在当前页面，但浏览器备份不可用，请勿关闭页面。';
        notify(
          'warning',
          'SAVE_CONFLICT',
          describeAdminApiError(error, '保存失败', { conflict: conflictMessage }),
        );
        return false;
      }
      if (isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.mediaReferenceMissing)) {
        const filenames = adminErrorStringList(error, 'filenames');
        const referencePaths = findContentReferencePaths(nextContent, new Set(filenames));
        setActiveSection('media');
        setMediaSearch('');
        notify(
          'warning',
          'SAVE_MEDIA_REFERENCE_MISSING',
          filenames.length > 0
            ? `保存已暂停：内容引用的媒体文件不存在（${summarizeStringList(filenames)}）。${referencePaths.length > 0 ? `引用位置：${summarizeStringList(referencePaths)}。` : ''}新上传文件会使用新名称，请上传替代图片后回到对应内容字段替换旧链接，或直接移除失效引用。`
            : '保存已暂停：内容引用的媒体文件不存在。请在媒体资源库上传替代图片，再回到对应内容字段替换旧链接，或移除失效引用。',
        );
        return false;
      }
      if (isAdminApiError(error, 'unauthorized')) {
        if (!await expireAdminSession()) return false;
      }
      notify('error', 'SAVE_FAILED', describeAdminApiError(error, '保存失败，请检查必填字段'));
      return false;
    } finally {
      if (activeSaveOperationRef.current?.id === saveOperationId) {
        activeSaveOperationRef.current = null;
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [
    captureEditorLease,
    content,
    contentVersion,
    expireAdminSession,
    isCurrentLease,
    notify,
    saveBlocked,
    saveBlockedByDraftChoice,
    savedSnapshot,
  ]);

  const loadServerVersionForConflict = useCallback(async () => {
    if (!saveConflict || saveConflict.serverContent || conflictResolving) return;
    const lease = captureEditorLease();
    if (!lease) return;
    const conflictOperationId = conflictOperationIdRef.current + 1;
    conflictOperationIdRef.current = conflictOperationId;
    draftEpochRef.current += 1;
    setConflictResolving(true);
    try {
      const requestStartedAt = new Date().toISOString();
      const requestDraft = structuredClone(contentRef.current);
      const requestBackup = await writeAdminDraft(createCurrentAdminDraft(
        saveConflict.baseEtag,
        saveConflict.baseContent,
        requestDraft,
        requestStartedAt,
      ), lease);
      if (!isCurrentLease(lease) || (!requestBackup.ok && requestBackup.code === 'stale-owner')) return;
      setSaveConflict((current) => current ? {
        ...current,
        localContent: requestDraft,
        detectedAt: requestStartedAt,
      } : null);
      setAutoBackupAt(requestBackup.ok ? new Date(requestStartedAt) : null);
      setAutoBackupUnavailable(!requestBackup.ok);
      const result = await adminApi.readContent();
      if (!isCurrentLease(lease)) return;
      if (!result.initialized) {
        notify('error', 'CONFLICT_SERVER_UNINITIALIZED', '服务器内容状态异常，已保留当前本地草稿，请稍后重试');
        return;
      }
      const serverContent = normalizeContent(result.content);
      const latestLocalContent = structuredClone(contentRef.current);
      const merged = mergeSiteContentVersions(saveConflict.baseContent, latestLocalContent, serverContent);
      const latestSavedAt = new Date().toISOString();
      const originalBackup = await writeAdminDraft(createCurrentAdminDraft(
        saveConflict.baseEtag,
        saveConflict.baseContent,
        latestLocalContent,
        latestSavedAt,
      ), lease);
      if (!isCurrentLease(lease) || (!originalBackup.ok && originalBackup.code === 'stale-owner')) return;
      contentRef.current = merged.content;
      contentSnapshotRef.current = JSON.stringify(merged.content);
      setContent(merged.content);
      setSavedSnapshot(JSON.stringify(serverContent));
      setContentVersion(result.etag);
      contentVersionRef.current = result.etag;
      baseContentRef.current = structuredClone(serverContent);
      setSelectedPostIds(new Set());
      setSelectedProjectIds(new Set());
      setSelectedPost(0);
      setSelectedProject(0);

      if (merged.conflicts.length === 0) {
        const rebasedBackup = await writeAdminDraft(createCurrentAdminDraft(
          result.etag,
          serverContent,
          merged.content,
          latestSavedAt,
        ), lease);
        if (!isCurrentLease(lease) || (!rebasedBackup.ok && rebasedBackup.code === 'stale-owner')) return;
        setSaveConflict(null);
        setAutoBackupAt(rebasedBackup.ok ? new Date(latestSavedAt) : originalBackup.ok ? new Date(latestSavedAt) : null);
        setAutoBackupUnavailable(!rebasedBackup.ok);
        notify(
          rebasedBackup.ok ? 'info' : 'warning',
          rebasedBackup.ok ? 'CONFLICT_AUTO_MERGED' : 'CONFLICT_DRAFT_BACKUP_FAILED',
          rebasedBackup.ok
            ? '服务器独立修改与本地草稿已自动合并，没有同字段冲突；确认后请再次保存。'
            : '服务器与本地内容已在当前页面自动合并，但无法基于最新版本更新浏览器备份，请勿关闭页面。',
        );
        return;
      }

      setSaveConflict((current) => current ? {
        ...current,
        localContent: structuredClone(latestLocalContent),
        serverEtag: result.etag,
        serverContent: structuredClone(serverContent),
        serverResolution: structuredClone(merged.content),
        localResolution: structuredClone(merged.localResolution),
        conflicts: merged.conflicts,
        resolution: null,
      } : null);
      setAutoBackupAt(originalBackup.ok ? new Date(latestSavedAt) : null);
      setAutoBackupUnavailable(!originalBackup.ok);
      const mergeMessage = `已保留双方的不重叠修改；${merged.conflicts.length} 个同字段冲突尚未选择，保存前必须明确采用服务器值或本地值。`;
      notify(
        'warning',
        originalBackup.ok ? 'CONFLICT_SERVER_LOADED' : 'CONFLICT_DRAFT_BACKUP_FAILED',
        originalBackup.ok
          ? mergeMessage
          : `${mergeMessage} 浏览器备份不可用，请勿关闭页面。`,
      );
    } catch (error) {
      if (!isCurrentLease(lease)) return;
      if (isAdminApiError(error, 'unauthorized')) {
        if (!await expireAdminSession()) return;
      }
      notify('error', 'CONFLICT_SERVER_LOAD_FAILED', describeAdminApiError(error, '无法读取服务器版本'));
    } finally {
      if (conflictOperationIdRef.current === conflictOperationId) setConflictResolving(false);
    }
  }, [captureEditorLease, conflictResolving, expireAdminSession, isCurrentLease, notify, saveConflict]);

  const chooseConflictResolution = async (resolution: 'server' | 'local') => {
    if (!saveConflict?.serverResolution
      || !saveConflict.localResolution
      || !saveConflict.serverContent
      || !saveConflict.serverEtag) return;
    if (saveConflict.resolution === resolution) return;
    const lease = captureEditorLease();
    if (!lease) return;
    draftEpochRef.current += 1;
    const previousResolution = saveConflict.resolution === 'local'
      ? saveConflict.localResolution
      : saveConflict.serverResolution;
    const selectedResolution = resolution === 'server'
      ? saveConflict.serverResolution
      : saveConflict.localResolution;
    const nextContent = mergeSiteContentVersions(
      previousResolution,
      contentRef.current,
      selectedResolution,
    ).content;
    contentRef.current = nextContent;
    contentSnapshotRef.current = JSON.stringify(nextContent);
    setContent(nextContent);
    setSelectedPostIds(new Set());
    setSelectedProjectIds(new Set());
    setSelectedPost(0);
    setSelectedProject(0);
    setSaveConflict((current) => current ? { ...current, resolution } : null);
    const backupSavedAt = new Date().toISOString();
    const backup = await writeAdminDraft(createCurrentAdminDraft(
      saveConflict.serverEtag,
      saveConflict.serverContent,
      nextContent,
      backupSavedAt,
    ), lease);
    if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return;
    setAutoBackupAt(backup.ok ? new Date(backupSavedAt) : null);
    setAutoBackupUnavailable(!backup.ok);
    notify(
      backup.ok ? 'info' : 'warning',
      backup.ok
        ? resolution === 'server' ? 'CONFLICT_SERVER_FIELDS_SELECTED' : 'CONFLICT_LOCAL_FIELDS_SELECTED'
        : 'CONFLICT_RESOLUTION_BACKUP_FAILED',
      `${resolution === 'server'
        ? '同字段冲突已采用服务器值；服务器与本地的不重叠修改均已保留。'
        : '同字段冲突已采用本地值；服务器与本地的不重叠修改均已保留。'}${backup.ok ? '' : ' 但无法更新浏览器备份，请勿关闭页面。'}`,
    );
  };

  const acceptConflictServerVersion = async () => {
    if (!saveConflict?.serverContent) return;
    const lease = captureEditorLease();
    if (!lease) return;
    draftEpochRef.current += 1;
    const serverContent = structuredClone(saveConflict.serverContent);
    contentRef.current = serverContent;
    contentSnapshotRef.current = JSON.stringify(serverContent);
    setContent(serverContent);
    setSavedSnapshot(JSON.stringify(serverContent));
    baseContentRef.current = structuredClone(serverContent);
    if (saveConflict.serverEtag) {
      setContentVersion(saveConflict.serverEtag);
      contentVersionRef.current = saveConflict.serverEtag;
    }
    const removed = await removeAdminDraft(lease);
    if (!isCurrentLease(lease) || (!removed.ok && removed.code === 'stale-owner')) return;
    setSaveConflict(null);
    setLocalDraft(null);
    setAutoBackupAt(null);
    setAutoBackupUnavailable(!removed.ok);
    notify(
      removed.ok ? 'info' : 'warning',
      removed.ok ? 'CONFLICT_SERVER_ACCEPTED' : 'CONFLICT_DRAFT_CLEANUP_FAILED',
      removed.ok
        ? '已采用服务器版本并丢弃本地冲突草稿。'
        : '已采用服务器版本，但无法清理浏览器中的旧草稿，请稍后手动丢弃。',
    );
  };

  useEffect(() => {
    if (!authenticated || !isDirty || !contentVersion || localDraft) return;
    const lease = captureEditorLease();
    if (!lease) return;
    let cancelled = false;
    const draftEpoch = draftEpochRef.current;
    const timer = window.setTimeout(() => {
      if (cancelled || draftEpoch !== draftEpochRef.current) return;
      const savedAt = new Date().toISOString();
      const backupRecord = saveConflict && saveBlockedByConflict
        ? createCurrentAdminDraft(
          saveConflict.baseEtag,
          saveConflict.baseContent,
          saveConflict.serverContent ? saveConflict.localContent : content,
          savedAt,
        )
        : createCurrentAdminDraft(contentVersion, baseContentRef.current, content, savedAt);
      void writeAdminDraft(backupRecord, lease).then((backup) => {
        if (
          cancelled
          || draftEpoch !== draftEpochRef.current
          || !isCurrentLease(lease)
          || (!backup.ok && backup.code === 'stale-owner')
        ) return;
        setAutoBackupAt(backup.ok ? new Date(savedAt) : null);
        setAutoBackupUnavailable(!backup.ok);
      });
    }, saving ? 0 : 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    authenticated,
    captureEditorLease,
    content,
    contentSnapshot,
    contentVersion,
    isCurrentLease,
    isDirty,
    localDraft,
    saveBlockedByConflict,
    saveConflict,
    saving,
  ]);

  useEffect(() => {
    if (!authenticated || contentLoadState !== 'ready' || localDraft) return;
    const lease = captureEditorLease();
    if (!lease) return;

    const persistLatestDraft = () => {
      const currentVersion = contentVersionRef.current;
      if (
        !currentVersion
        || !isCurrentLease(lease)
        || contentSnapshotRef.current === savedSnapshot
      ) return;
      const savedAt = new Date().toISOString();
      const backupRecord = saveConflict && saveBlockedByConflict
        ? createCurrentAdminDraft(
          saveConflict.baseEtag,
          saveConflict.baseContent,
          saveConflict.serverContent ? saveConflict.localContent : contentRef.current,
          savedAt,
        )
        : createCurrentAdminDraft(
          currentVersion,
          baseContentRef.current,
          contentRef.current,
          savedAt,
        );
      void writeAdminDraft(backupRecord, lease).then((backup) => {
        if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return;
        setAutoBackupAt(backup.ok ? new Date(savedAt) : null);
        setAutoBackupUnavailable(!backup.ok);
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persistLatestDraft();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', persistLatestDraft);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', persistLatestDraft);
    };
  }, [
    authenticated,
    captureEditorLease,
    contentLoadState,
    isCurrentLease,
    localDraft,
    saveBlockedByConflict,
    saveConflict,
    savedSnapshot,
  ]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (commandPaletteOpen) return;
        if (isDirty && !saving && !saveBlocked) void save();
      }
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [commandPaletteOpen, isDirty, save, saveBlocked, saving]);

  const logout = async () => {
    if (endingSessionRef.current) return;
    if ((isDirty || saveConflict) && !window.confirm('当前还有未保存的更改或未解决的保存冲突，确定退出吗？')) return;
    endingSessionRef.current = true;
    saveBlockedRef.current = true;
    mediaRequestIdRef.current += 1;
    revisionsRequestIdRef.current += 1;
    closeTransientAdminUi();
    setEndingSession(true);
    draftEpochRef.current += 1;
    try {
      const activeSaveOperation = activeSaveOperationRef.current;
      activeSaveOperation?.controller?.abort();
      activeSaveOperationRef.current = null;
      saveInFlightRef.current = false;
      setSaving(false);
      conflictOperationIdRef.current += 1;
      setConflictResolving(false);

      if ((isDirty || saveConflict) && !await flushCurrentDraft()) {
        setAutoBackupUnavailable(true);
        notify('error', 'LOGOUT_DRAFT_BACKUP_FAILED', '退出已取消：浏览器未能安全保存当前草稿，请检查存储权限后重试。');
        return;
      }

      await rotateEditorLease();
      try {
        await adminApi.logout();
      } catch (error) {
        if (!isAdminApiError(error, 'unauthorized')) {
          setContentLoadState((current) => current === 'loading' ? 'idle' : current);
          notify('error', 'LOGOUT_FAILED', describeAdminApiError(error, '退出登录失败'));
          return;
        }
      }
      setAuthenticated(false);
      setAuthStatusError('');
      setContentLoadState('idle');
      setContentLoadError('');
      setSaveConflict(null);
      setNotice(null);
    } finally {
      endingSessionRef.current = false;
      setEndingSession(false);
    }
  };

  const updateProject = (patch: Partial<Project>) => {
    if (patch.id !== undefined) setSelectedProjectIds(new Set());
    setContent((current) => ({ ...current, projects: current.projects.map((item, index) => index === selectedProject ? { ...item, ...patch } : item) }));
  };

  const updatePost = (patch: Partial<BlogPost>) => {
    if (patch.id !== undefined) setSelectedPostIds(new Set());
    setContent((current) => ({ ...current, blogPosts: current.blogPosts.map((item, index) => index === selectedPost ? { ...item, ...patch } : item) }));
  };

  const commitPostTags = (rawTags: string) => {
    const additions = rawTags
      .split(/[,，]/)
      .map((value) => value.trim().replace(/^#+/, ''))
      .filter(Boolean);
    if (additions.length === 0) {
      setPostTagDraft('');
      return;
    }
    setContent((current) => ({
      ...current,
      blogPosts: current.blogPosts.map((item, index) => {
        if (index !== selectedPost) return item;
        const nextTags = [...item.tags];
        additions.forEach((tag) => {
          if (!nextTags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) nextTags.push(tag);
        });
        return { ...item, tags: nextTags };
      }),
    }));
    setPostTagDraft('');
  };

  const removePostTag = (tag: string) => {
    setContent((current) => ({
      ...current,
      blogPosts: current.blogPosts.map((item, index) => index === selectedPost
        ? { ...item, tags: item.tags.filter((entry) => entry !== tag) }
        : item),
    }));
  };

  const updateExperience = (index: number, patch: Partial<(typeof content.personalInfo.experience)[number]>) => {
    setContent((current) => ({
      ...current,
      personalInfo: {
        ...current.personalInfo,
        experience: current.personalInfo.experience.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
      },
    }));
  };

  const optionalNumber = (value: string) => value === '' ? undefined : Number(value);

  const updateSiteSettings = (updater: (value: SiteContent['siteSettings']) => SiteContent['siteSettings']) => {
    setContent((current) => ({ ...current, siteSettings: updater(current.siteSettings) }));
  };

  const updateHomePage = (updater: (value: SiteContent['homePage']) => SiteContent['homePage']) => {
    setContent((current) => ({ ...current, homePage: updater(current.homePage) }));
  };

  const updateShowcasePage = (patch: Partial<SiteContent['showcasePage']>) => {
    setContent((current) => ({ ...current, showcasePage: { ...current.showcasePage, ...patch } }));
  };

  const updateBlogPage = (patch: Partial<SiteContent['blogPage']>) => {
    setContent((current) => ({ ...current, blogPage: { ...current.blogPage, ...patch } }));
  };

  const updateAboutPage = (updater: (value: SiteContent['aboutPage']) => SiteContent['aboutPage']) => {
    setContent((current) => ({ ...current, aboutPage: updater(current.aboutPage) }));
  };

  const updateAgentPage = (updater: (value: SiteContent['agentPage']) => SiteContent['agentPage']) => {
    setContent((current) => ({ ...current, agentPage: updater(current.agentPage) }));
  };

  const updateMusicPlayer = (updater: (value: SiteContent['musicPlayer']) => SiteContent['musicPlayer']) => {
    setContent((current) => ({ ...current, musicPlayer: updater(current.musicPlayer) }));
  };

  const addProject = () => {
    if (saveBlockedRef.current) return;
    const project: Project = { id: `project-${Date.now()}`, title: '新项目', description: '', tags: [], stats: {}, featured: false, role: '', year: String(new Date().getFullYear()) };
    setContent((current) => ({ ...current, projects: [...current.projects, project] }));
    setSelectedProject(content.projects.length);
  };

  const addPost = () => {
    if (saveBlockedRef.current) return;
    const post = createDraftBlogPost();
    setContent((current) => ({ ...current, blogPosts: [...current.blogPosts, post] }));
    setSelectedPost(content.blogPosts.length);
    setPostEditorOpen(true);
    setPostEditorView('write');
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="文章标题"]')?.focus());
  };

  const uploadImage = async (file?: File) => {
    if (!file || saveBlockedRef.current) return;
    const lease = captureEditorLease();
    if (!lease) return;
    const targetPostId = content.blogPosts[selectedPost]?.id;
    if (!targetPostId) return;
    setUploading(true);
    setNotice(null);
    try {
      const result = await adminApi.uploadMedia(file);
      if (!isCurrentLease(lease) || saveBlockedRef.current) return;
      setContent((current) => ({
        ...current,
        blogPosts: current.blogPosts.map((item) => item.id === targetPostId
          ? { ...item, coverImage: item.coverImage || result.url, content: `${item.content}\n\n![${file.name}](${result.url})` }
          : item),
      }));
      notify('success', 'POST_IMAGE_UPLOADED', '图片已上传，并插入到文章末尾');
    } catch (error) {
      if (!isCurrentLease(lease)) return;
      if (isAdminApiError(error, 'unauthorized') && !await expireAdminSession()) return;
      notify('error', 'IMAGE_UPLOAD_FAILED', describeAdminApiError(error, '图片上传失败，请使用 8MB 以内的 JPG、PNG、WebP 或 GIF'));
    } finally {
      setUploading(false);
    }
  };

  const loadMedia = useCallback(async () => {
    const requestId = ++mediaRequestIdRef.current;
    setMediaState(beginResourceLoad);
    try {
      const items = await adminApi.listMedia();
      if (requestId !== mediaRequestIdRef.current) return;
      setMediaItems(items.map((item) => contentSnapshotRef.current.includes(item.filename)
        ? { ...item, referenced: true, references: item.references.length ? item.references : ['当前未保存内容'] }
        : item));
      setMediaState(completeResourceLoad(items.length));
    } catch (error) {
      if (requestId !== mediaRequestIdRef.current || isAdminApiError(error, 'aborted')) return;
      const message = describeAdminApiError(error, '无法读取媒体资源');
      if (isAdminApiError(error, 'unauthorized')) {
        if (await expireAdminSession()) notify('error', 'SESSION_EXPIRED', message);
        return;
      }
      setMediaState((current) => failResourceLoad(current, message));
    }
  }, [expireAdminSession, notify]);

  const loadRevisions = useCallback(async () => {
    const requestId = ++revisionsRequestIdRef.current;
    setRevisionsState(beginResourceLoad);
    try {
      const items = await adminApi.listRevisions();
      if (requestId !== revisionsRequestIdRef.current) return;
      setRevisions(items);
      setRevisionsState(completeResourceLoad(items.length));
    } catch (error) {
      if (requestId !== revisionsRequestIdRef.current || isAdminApiError(error, 'aborted')) return;
      const message = describeAdminApiError(error, '无法读取版本历史');
      if (isAdminApiError(error, 'unauthorized')) {
        if (await expireAdminSession()) notify('error', 'SESSION_EXPIRED', message);
        return;
      }
      setRevisionsState((current) => failResourceLoad(current, message));
    }
  }, [expireAdminSession, notify]);

  useEffect(() => () => {
    mediaRequestIdRef.current += 1;
    revisionsRequestIdRef.current += 1;
  }, []);

  useEffect(() => {
    if (authenticated && activeSection === 'media') void loadMedia();
  }, [activeSection, authenticated, loadMedia]);

  useEffect(() => {
    setMediaItems((current) => current.map((item) => {
      const localReference = contentSnapshot.includes(item.filename);
      const persistedReferences = item.references.filter((reference) => !reference.startsWith('当前未保存'));
      const references = localReference && persistedReferences.length === 0
        ? ['当前未保存内容']
        : persistedReferences;
      return { ...item, referenced: localReference || persistedReferences.length > 0, references };
    }));
  }, [contentSnapshot]);

  useEffect(() => {
    if (authenticated && revisionsOpen) void loadRevisions();
  }, [authenticated, loadRevisions, revisionsOpen]);

  const uploadLibraryImage = async (file?: File) => {
    if (!file || saveBlockedRef.current) return;
    const lease = captureEditorLease();
    if (!lease) return;
    setUploading(true);
    setNotice(null);
    try {
      const uploaded = await adminApi.uploadMedia(file);
      if (!isCurrentLease(lease) || saveBlockedRef.current) return;
      await loadMedia();
      if (!isCurrentLease(lease) || saveBlockedRef.current) return;
      notify('success', 'MEDIA_UPLOADED', '图片已上传到媒体资源库');
      return { ...uploaded, referenced: false, references: [] } satisfies MediaItem;
    } catch (error) {
      if (!isCurrentLease(lease)) return;
      if (isAdminApiError(error, 'unauthorized') && !await expireAdminSession()) return;
      notify('error', 'MEDIA_UPLOAD_FAILED', describeAdminApiError(error, '图片上传失败，请使用 8MB 以内的 JPG、PNG、WebP 或 GIF'));
    } finally {
      setUploading(false);
    }
  };

  const deleteMedia = async (item: MediaItem) => {
    if (saveBlockedRef.current) return;
    const lease = captureEditorLease();
    if (!lease) return;
    try {
      await adminApi.deleteMedia(item.filename);
      if (!isCurrentLease(lease) || saveBlockedRef.current) return;
    } catch (error) {
      if (!isCurrentLease(lease)) return;
      if (isAdminApiError(error, 'unauthorized')) {
        if (await expireAdminSession()) {
          notify('error', 'SESSION_EXPIRED', describeAdminApiError(error, '会话已失效'));
        }
        return;
      }
      if (isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.mediaStillReferenced)) {
        const references = adminErrorStringList(error, 'references');
        setMediaItems((current) => current.map((mediaItem) => mediaItem.filename === item.filename
          ? { ...mediaItem, referenced: true, references }
          : mediaItem));
        setConfirmation((current) => current ? { ...current, confirmDisabled: true } : null);
        void loadMedia();
        throw new Error(references.length > 0
          ? `图片仍被引用，无法删除。引用位置：${summarizeStringList(references)}`
          : '图片仍被站点内容或历史版本引用，无法删除');
      }
      throw new Error(describeAdminApiError(error, '删除图片失败', {
        http: '删除图片失败，请刷新媒体资源库后重试',
      }));
    }
    await loadMedia();
    if (!isCurrentLease(lease) || saveBlockedRef.current) return;
    notify('success', 'MEDIA_DELETED', '图片已从媒体资源库删除');
  };

  const loadRevisionIntoEditor = async (revision: RevisionSummary) => {
    if (saveBlockedRef.current) return;
    const lease = captureEditorLease();
    if (!lease) return;
    let revisionContent: SiteContent;
    try {
      revisionContent = normalizeContent(await adminApi.readRevision(revision.id));
    } catch (error) {
      if (!isCurrentLease(lease)) return;
      if (isAdminApiError(error, 'unauthorized')) {
        if (await expireAdminSession()) {
          notify('error', 'SESSION_EXPIRED', describeAdminApiError(error, '会话已失效'));
        }
        return;
      }
      if (isAdminApiErrorCode(error, ADMIN_API_ERROR_CODES.revisionIncompatible)) {
        throw new Error('该历史版本与当前内容结构不兼容，无法载入编辑器');
      }
      throw new Error(describeAdminApiError(error, '无法读取该版本'));
    }
    if (!isCurrentLease(lease) || saveBlockedRef.current) return;
    setContent(revisionContent);
    setSelectedPostIds(new Set());
    setSelectedProjectIds(new Set());
    setSelectedPost(0);
    setSelectedProject(0);
    setRevisionsOpen(false);
    notify('info', 'REVISION_LOADED', '历史版本已载入编辑器，确认无误后请手动保存');
  };

  const restoreLocalDraft = async () => {
    if (!localDraft || draftChoiceResolvingRef.current) return;
    const lease = captureEditorLease();
    if (!lease) return;
    if (!contentVersion) {
      notify('error', 'LOCAL_DRAFT_BASE_MISSING', '无法确认当前服务器版本，暂时不能采用本地草稿。');
      return;
    }
    draftChoiceResolvingRef.current = true;
    setDraftChoiceResolving(true);
    draftEpochRef.current += 1;
    const restoredContent = normalizeSiteContent(localDraft.content);
    const restoredAt = new Date().toISOString();
    try {
      const backup = await writeAdminDraft(createCurrentAdminDraft(
        contentVersion,
        baseContentRef.current,
        restoredContent,
        restoredAt,
      ), lease);
      if (!isCurrentLease(lease) || (!backup.ok && backup.code === 'stale-owner')) return;
      if (!backup.ok) {
        setAutoBackupUnavailable(true);
        notify('warning', 'LOCAL_DRAFT_REBASE_FAILED', '无法建立新版浏览器备份，尚未采用本地草稿，请检查浏览器存储权限后重试。');
        return;
      }
      const legacyRemoved = localDraft.kind === 'legacy'
        ? await removeLegacyAdminDraft(lease)
        : null;
      if (
        !isCurrentLease(lease)
        || (legacyRemoved && !legacyRemoved.ok && legacyRemoved.code === 'stale-owner')
      ) return;
      contentRef.current = restoredContent;
      contentSnapshotRef.current = JSON.stringify(restoredContent);
      setContent(restoredContent);
      setSelectedPostIds(new Set());
      setSelectedProjectIds(new Set());
      setSelectedPost(0);
      setSelectedProject(0);
      setAutoBackupAt(new Date(restoredAt));
      setAutoBackupUnavailable(false);
      setLocalDraft(null);
      notify(
        !legacyRemoved || legacyRemoved.ok ? 'info' : 'warning',
        'LOCAL_DRAFT_SELECTED',
        `已明确采用整个本地草稿并基于当前服务器版本建立新备份；确认后请手动保存。${legacyRemoved && !legacyRemoved.ok ? ' 旧版备份未能清理，但新版草稿已安全保留。' : ''}`,
      );
    } finally {
      draftChoiceResolvingRef.current = false;
      setDraftChoiceResolving(false);
    }
  };

  const requestRestoreLocalDraft = () => {
    if (draftChoiceResolvingRef.current) return;
    if (!isDirty) {
      void restoreLocalDraft();
      return;
    }
    setConfirmation({
      title: '采用整个本地草稿？',
      description: '本地草稿没有可用于安全合并的可信基础版本。此操作会整份替换当前编辑器中的服务器内容，之后仍需手动保存。',
      confirmLabel: '采用本地草稿',
      tone: 'warning',
      onConfirm: async () => { await restoreLocalDraft(); },
    });
  };

  const discardLocalDraft = async () => {
    if (!localDraft || draftChoiceResolvingRef.current) return;
    const lease = captureEditorLease();
    if (!lease) return;
    draftChoiceResolvingRef.current = true;
    setDraftChoiceResolving(true);
    draftEpochRef.current += 1;
    try {
      const removed = localDraft.kind === 'legacy'
        ? await removeLegacyAdminDraft(lease)
        : await removeAdminDraft(lease);
      if (!isCurrentLease(lease) || (!removed.ok && removed.code === 'stale-owner')) return;
      if (!removed.ok) {
        setAutoBackupUnavailable(true);
        notify('error', 'LOCAL_DRAFT_DELETE_FAILED', '无法删除本地备份，请检查浏览器存储权限后重试');
        return;
      }
      setAutoBackupUnavailable(false);
      setAutoBackupAt(null);
      setLocalDraft(null);
      notify('info', 'LOCAL_DRAFT_SERVER_SELECTED', '已明确保留整个服务器版本，并丢弃本地草稿。');
    } finally {
      draftChoiceResolvingRef.current = false;
      setDraftChoiceResolving(false);
    }
  };

  const insertMarkdown = (prefix: string, suffix = '', placeholder = '文本') => {
    const editor = (editorFocusMode ? focusMarkdownEditorRef.current : markdownEditorRef.current)
      ?? document.querySelector<HTMLTextAreaElement>('#admin-workspace textarea.font-mono');
    const currentPost = content.blogPosts[selectedPost];
    if (!currentPost) return;
    const start = editor?.selectionStart ?? currentPost.content.length;
    const end = editor?.selectionEnd ?? currentPost.content.length;
    const selected = currentPost.content.slice(start, end) || placeholder;
    const next = `${currentPost.content.slice(0, start)}${prefix}${selected}${suffix}${currentPost.content.slice(end)}`;
    updatePost({ content: next, readTime: estimateReadTime(next) });
    window.requestAnimationFrame(() => {
      editor?.focus();
      editor?.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    });
  };

  const insertMediaIntoPost = (item: MediaItem, altText = item.filename) => {
    if (saveBlockedRef.current) return;
    const currentPost = content.blogPosts[selectedPost];
    if (!currentPost) {
      notify('warning', 'POST_REQUIRED', '请先创建一篇文章');
      return;
    }
    const editor = editorFocusMode ? focusMarkdownEditorRef.current : markdownEditorRef.current;
    const start = editor?.selectionStart ?? currentPost.content.length;
    const end = editor?.selectionEnd ?? currentPost.content.length;
    const needsLeadingBreak = start > 0 && !currentPost.content.slice(0, start).endsWith('\n');
    const markdown = `${needsLeadingBreak ? '\n\n' : ''}![${altText || '文章图片'}](${item.url})`;
    const nextContent = `${currentPost.content.slice(0, start)}${markdown}${currentPost.content.slice(end)}`;
    updatePost({ content: nextContent, readTime: estimateReadTime(nextContent) });
    setMediaItems((current) => current.map((entry) => entry.filename === item.filename
      ? { ...entry, referenced: true, references: [...entry.references, '当前未保存文章'] }
      : entry));
    notify('success', 'MEDIA_INSERTED', '图片已插入光标位置');
    window.requestAnimationFrame(() => {
      const cursor = start + markdown.length;
      editor?.focus();
      editor?.setSelectionRange(cursor, cursor);
    });
  };

  const setMediaAsPostCover = (item: MediaItem) => {
    if (saveBlockedRef.current) return;
    if (!content.blogPosts[selectedPost]) {
      notify('warning', 'POST_REQUIRED', '请先创建一篇文章');
      return;
    }
    updatePost({ coverImage: item.url });
    setMediaItems((current) => current.map((entry) => entry.filename === item.filename
      ? { ...entry, referenced: true, references: [...entry.references, '当前未保存封面'] }
      : entry));
    notify('success', 'POST_COVER_UPDATED', '文章封面已更新，保存后生效');
  };

  if (authenticated === null) {
    if (authStatusError) {
      return <AdminAuthUnavailableState error={authStatusError} onRetry={() => { void checkAuthentication(); }} />;
    }
    return (
      <div className="grid min-h-screen place-items-center bg-[#07080c] px-5 text-zinc-400">
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <div className="grid h-12 w-12 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-indigo-300">
            <LoaderCircle size={20} className="animate-spin" />
          </div>
          <div className="text-center"><p className="text-sm font-medium text-zinc-200">正在连接内容工作台</p><p className="mt-1 text-xs text-zinc-500">正在验证登录状态</p></div>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#07080c] px-5 py-10 text-white">
        <div className="w-full max-w-sm">
          <div className="mb-7 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-lg border border-indigo-400/25 bg-indigo-500/10 text-indigo-200"><ShieldCheck size={19} /></div>
            <div><p className="text-sm font-semibold">Beta-Demo777</p><p className="mt-0.5 text-xs text-zinc-400">个人作品集内容工作台</p></div>
          </div>

          <form onSubmit={login} className="rounded-lg border border-white/[0.09] bg-[#0d1017] p-6 shadow-xl shadow-black/25 sm:p-7">
            <h1 className="text-xl font-semibold">管理员登录</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-400">输入管理员密码以继续管理文章、作品与站点内容。</p>

            <div className="mt-7 space-y-3">
              <div className={labelClass}>
                <label htmlFor="admin-password" className="block">管理员密码</label>
                <span className="relative block">
                  <input
                    id="admin-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => { setPassword(event.target.value); if (notice) setNotice(null); }}
                    placeholder="输入管理员密码"
                    autoComplete="current-password"
                    className={`${inputClass} h-12 pr-12`}
                    required
                    autoFocus
                    disabled={loggingIn}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    className="absolute inset-y-0 right-0 grid w-12 place-items-center text-zinc-500 transition hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </span>
              </div>
              {notice && <div role="alert" data-notice-code={notice.code} data-tone={notice.tone} className="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.07] px-3.5 py-3 text-sm leading-6 text-rose-200"><ShieldCheck size={15} className="mt-1 shrink-0" />{notice.message}</div>}
            </div>

            <button type="submit" aria-busy={loggingIn} disabled={loggingIn || !password.trim()} className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-sm font-semibold transition hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/25 disabled:cursor-not-allowed disabled:opacity-45">
              {loggingIn ? <><LoaderCircle size={17} className="animate-spin" />正在登录…</> : <>进入工作台<ChevronRight size={16} /></>}
            </button>
            <p className="mt-5 flex items-center justify-center gap-2 text-xs text-zinc-400"><ShieldCheck size={13} />密码只用于本次安全会话</p>
          </form>
        </div>
      </main>
    );
  }

  if (editorLockStatus !== 'held') {
    const unavailable = editorLockStatus === 'unavailable';
    const contended = editorLockStatus === 'contended';
    return (
      <main className="grid min-h-screen place-items-center bg-[#07080c] px-5 py-10 text-white">
        <section aria-labelledby="admin-editor-lock-title" className="w-full max-w-md border border-white/[0.09] bg-[#0d1017] p-6 sm:p-7">
          <span className={`grid h-11 w-11 place-items-center rounded-lg border ${unavailable ? 'border-rose-400/20 bg-rose-400/[0.08] text-rose-200' : contended ? 'border-amber-400/20 bg-amber-400/[0.08] text-amber-200' : 'border-indigo-400/20 bg-indigo-400/[0.08] text-indigo-200'}`}>
            {unavailable || contended ? <CircleAlert size={18} aria-hidden="true" /> : <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />}
          </span>
          <h1 id="admin-editor-lock-title" className="mt-5 text-xl font-semibold">
            {unavailable ? '当前浏览器无法安全编辑' : contended ? '另一个标签页正在编辑' : '正在取得编辑权限'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            {unavailable
              ? '此浏览器不支持跨标签页编辑锁。请使用最新版 Chrome、Edge、Firefox 或 Safari 打开后台。'
              : contended
                ? '为防止两个标签页互相覆盖本地草稿，此页面暂不载入编辑器。关闭另一个后台标签页后，这里会自动读取最新内容。'
                : '正在确认当前标签页是唯一的内容编辑器。'}
          </p>
          <div role="status" aria-live="polite" className="mt-5 border-l-2 border-white/10 pl-3 text-xs leading-5 text-zinc-500">
            {contended ? '每 2 秒自动重试' : unavailable ? '编辑与保存均未启用' : '请稍候'}
          </div>
          <button type="button" onClick={() => { void logout(); }} className="mt-6 min-h-11 w-full rounded-lg border border-white/[0.09] px-4 text-sm text-zinc-300 transition hover:bg-white/[0.04] hover:text-white">
            退出登录
          </button>
        </section>
      </main>
    );
  }

  if (contentLoadState !== 'ready') {
    return (
      <AdminContentLoadState
        status={contentLoadState === 'error' ? 'error' : 'loading'}
        error={contentLoadError}
        onRetry={() => { void loadContent(); }}
        onLogout={() => { void logout(); }}
      />
    );
  }

  const project = content.projects[selectedProject];
  const post = content.blogPosts[selectedPost];
  let persistedContent: SiteContent | null = null;
  try {
    persistedContent = JSON.parse(savedSnapshot) as SiteContent;
  } catch {
    persistedContent = null;
  }
  const persistedPost = post
    ? persistedContent?.blogPosts.find((item) => item.id === post.id) ?? persistedContent?.blogPosts[selectedPost]
    : undefined;
  const isPostDirty = Boolean(post && JSON.stringify(post) !== JSON.stringify(persistedPost));
  const postPublishChecks = post ? getPostPublishChecks(post) : { blocking: [], warnings: [] };
  const postScheduleIsInvalid = Boolean(post?.scheduledAt && !isValidScheduledAt(post.scheduledAt));
  const postPublishIssues = [...postPublishChecks.blocking, ...(postScheduleIsInvalid ? ['修正无效的定时发布时间'] : []), ...postPublishChecks.warnings];
  const postTextCount = post ? countArticleText(post.content) : { chineseCharacters: 0, latinWords: 0, totalCharacters: 0 };
  const postOutline = post ? getMarkdownOutline(post.content) : [];
  const postCategories = Array.from(new Set(content.blogPosts.map((item) => item.category.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const postTagSuggestions = Array.from(new Set(content.blogPosts.flatMap((item) => item.tags.map((tag) => tag.trim())).filter(Boolean)))
    .filter((tag) => !post?.tags.some((currentTag) => currentTag.toLocaleLowerCase() === tag.toLocaleLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const scheduledPostTime = post?.scheduledAt ? new Date(post.scheduledAt) : null;
  const postIsScheduled = Boolean(scheduledPostTime && !Number.isNaN(scheduledPostTime.getTime()) && scheduledPostTime.getTime() > Date.now());
  const draftPosts = content.blogPosts.filter((item) => item.status === 'draft').length;
  const draftPostEntries = content.blogPosts
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'draft')
    .sort((a, b) => b.item.date.localeCompare(a.item.date))
    .slice(0, 4);
  const postsNeedingAttention = content.blogPosts.filter((item) => (
    !item.title.trim() || !item.content.trim() || !item.excerpt.trim() || !item.coverImage
  ));
  const recentPosts = content.blogPosts
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.date.localeCompare(a.item.date))
    .slice(0, 5);
  const normalizedPostSearch = postSearch.trim().toLocaleLowerCase();
  const filteredPostEntries = content.blogPosts
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const matchesStatus = postStatusFilter === 'all' || item.status === postStatusFilter;
      const haystack = [item.title, item.excerpt, item.category, ...item.tags].join(' ').toLocaleLowerCase();
      return matchesStatus && (!normalizedPostSearch || haystack.includes(normalizedPostSearch));
    })
    .sort((a, b) => postSort === 'title'
      ? a.item.title.localeCompare(b.item.title, 'zh-CN')
      : postSort === 'oldest'
        ? a.item.date.localeCompare(b.item.date)
        : b.item.date.localeCompare(a.item.date));
  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
  const filteredProjectEntries = content.projects
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const matchesFilter = projectFilter === 'all' || (projectFilter === 'featured' ? item.featured : !item.featured);
      const haystack = [item.title, item.description, item.role, item.year, ...item.tags].join(' ').toLocaleLowerCase();
      return matchesFilter && (!normalizedProjectSearch || haystack.includes(normalizedProjectSearch));
    });
  const previewPage: PageId = activeSection === 'blogPosts' || activeSection === 'blogPage'
    ? 'blog'
    : activeSection === 'projects' || activeSection === 'techStackGroups' || activeSection === 'showcasePage'
      ? 'showcase'
      : activeSection === 'aboutPage' || activeSection === 'personalInfo'
        ? 'about'
        : activeSection === 'agentPage'
          ? 'agent'
          : 'home';
  const filteredMediaItems = mediaItems.filter((item) => item.filename.toLocaleLowerCase().includes(mediaSearch.trim().toLocaleLowerCase()));
  const previewUrl = `/?preview=${previewPage}${previewPage === 'blog' && post ? `&post=${encodeURIComponent(post.id)}` : ''}`;
  const ActiveIcon = activeNavigation.icon;
  const commandPaletteBlocked = saveBlocked
    || sidebarIsModal
    || revisionsOpen
    || previewOpen
    || mediaPickerOpen
    || Boolean(confirmation)
    || editorFocusMode
    || postSettingsIsModal;

  const openSection = (key: AdminSectionKey) => {
    setActiveSection(key);
    setSidebarOpen(false);
    if (key !== 'blogPosts') {
      setPostSettingsOpen(false);
      setPostToolbarMenuOpen(false);
      setPostOutlineOpen(false);
    }
  };

  const openPostEditor = (index: number) => {
    setSelectedPost(index);
    setPostEditorOpen(true);
    setPostSettingsOpen(false);
    openSection('blogPosts');
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="文章标题"]')?.focus());
  };

  const closePostEditor = () => {
    setPostEditorOpen(false);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-post-index="${selectedPost}"]`)?.focus());
  };

  const saveCurrentPost = (closeSettings = false) => save(content, {
    successMessage: post?.status === 'draft'
      ? '草稿已保存；本次其他待保存更改也已一并同步'
      : '文章已更新；本次其他待保存更改也已一并同步',
    closePostSettingsOnSuccess: closeSettings,
  });

  const publishCurrentPost = (closeSettings = false) => {
    if (!post) return Promise.resolve(false);
    const nextContent: SiteContent = {
      ...content,
      blogPosts: content.blogPosts.map((item, index) => index === selectedPost ? { ...item, status: 'published' } : item),
    };
    const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;
    const scheduled = Boolean(scheduledAt && !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now());
    return save(nextContent, {
      successMessage: scheduled && scheduledAt
        ? `发布计划已保存；文章将在 ${scheduledAt.toLocaleString('zh-CN')} 自动公开`
        : '文章已发布；公开博客刷新后即可看到',
      closePostSettingsOnSuccess: closeSettings,
    });
  };

  const withdrawCurrentPost = () => {
    if (!post) return;
    if (!persistedPost || persistedPost.status !== 'published') {
      updatePost({ status: 'draft' });
      notify('info', 'POST_RETURNED_TO_DRAFT', '文章已恢复为草稿状态');
      return;
    }
    const nextContent: SiteContent = {
      ...content,
      blogPosts: content.blogPosts.map((item, index) => index === selectedPost ? { ...item, status: 'draft' } : item),
    };
    setConfirmation({
      title: `撤回文章“${post.title || '未命名文章'}”？`,
      description: '保存后文章会从公开博客隐藏，但内容仍会保留在草稿列表中。',
      confirmLabel: '撤回文章',
      tone: 'warning',
      onConfirm: async () => { await save(nextContent, { successMessage: '文章已撤回并保存为草稿', closePostSettingsOnSuccess: true }); },
    });
  };

  const persistedPostIsPublished = Boolean(persistedPost && persistedPost.status === 'published');
  const articlePrimaryLabel = post?.status === 'draft'
    ? '保存草稿'
    : !persistedPostIsPublished
      ? postIsScheduled ? '安排发布' : '发布文章'
      : postIsScheduled ? '更新发布计划' : '更新文章';
  const handleArticlePrimaryAction = (closeSettings = false) => {
    if (!post) return Promise.resolve(false);
    if (post.status === 'draft' || persistedPostIsPublished) return saveCurrentPost(closeSettings);
    return publishCurrentPost(closeSettings);
  };

  const togglePostSelectionMode = () => {
    setPostSelectionMode((current) => !current);
    setSelectedPostIds(new Set());
  };

  const jumpToOutlineLine = (line: number) => {
    if (!post) return;
    if (postEditorView === 'preview') {
      setPostEditorView(window.matchMedia('(max-width: 639px)').matches ? 'write' : 'split');
    }
    window.requestAnimationFrame(() => {
      const editor = markdownEditorRef.current;
      if (!editor) return;
      const offset = post.content.split(/\r\n?|\n/).slice(0, Math.max(0, line - 1)).reduce((total, value) => total + value.length + 1, 0);
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(offset, offset);
      const scrollContainer = editor.closest<HTMLElement>('[data-post-editor-scroll]');
      if (!scrollContainer) return;
      const editorOffset = editor.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop;
      const caretTop = measureTextareaCaretTop(editor, post.content, offset);
      scrollContainer.scrollTo({ top: Math.max(0, editorOffset + caretTop - 180), behavior: 'smooth' });
    });
  };

  const commandActions: CommandPaletteAction[] = [
    ...allNavigationEntries.map((entry) => ({
      id: `section-${entry.key}`,
      label: entry.label,
      description: entry.description,
      group: '跳转页面',
      keywords: [entry.key],
      icon: entry.icon,
      onSelect: () => openSection(entry.key),
    })),
    {
      id: 'new-post', label: '新建文章', description: '创建一篇草稿并开始编辑', group: '内容操作',
      keywords: ['blog', 'draft'], icon: FilePlus2, disabled: saveBlocked, onSelect: () => {
        if (saveBlockedRef.current) return;
        addPost();
        openSection('blogPosts');
      },
    },
    {
      id: 'new-project', label: '新建作品项目', description: '向作品集添加新项目', group: '内容操作',
      keywords: ['project'], icon: FolderKanban, disabled: saveBlocked, onSelect: () => {
        if (saveBlockedRef.current) return;
        addProject();
        openSection('projects');
      },
    },
    {
      id: 'preview', label: '实时预览当前内容', description: '使用当前未保存内容进行多端预览', group: '工作流',
      keywords: ['preview', 'mobile'], icon: Eye, onSelect: () => setPreviewOpen(true),
    },
    {
      id: 'revisions', label: '打开版本历史', description: '查看并恢复过去的内容快照', group: '工作流',
      keywords: ['history', 'restore'], icon: History, disabled: saveBlocked, onSelect: () => {
        if (!saveBlockedRef.current) setRevisionsOpen(true);
      },
    },
    {
      id: 'save', label: '保存全部更改', description: isDirty ? `保存 ${changedSections.length} 个已修改内容分区` : '当前没有待保存更改', group: '工作流',
      keywords: ['save', 'publish'], icon: Save, shortcut: '⌘S', disabled: !isDirty || saving || saveBlocked, onSelect: () => void save(),
    },
  ];

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div
      inert={endingSession ? true : undefined}
      aria-busy={endingSession || undefined}
      className="min-h-screen overflow-x-hidden bg-[#07080c] text-white selection:bg-indigo-500/30"
    >
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} actions={commandActions} enableKeyboardShortcut={!commandPaletteBlocked} />
      <ResponsivePreview open={previewOpen} onOpenChange={setPreviewOpen} url={previewUrl} previewContent={content} />
      <MediaPickerDialog
        open={mediaPickerOpen && !saveBlocked}
        onOpenChange={(open) => {
          if (!open || !saveBlockedRef.current) setMediaPickerOpen(open);
        }}
        items={mediaItems}
        loading={mediaState.status === 'idle' || mediaState.status === 'loading'}
        loadError={mediaState.error}
        stale={mediaState.status === 'stale'}
        onRetry={() => { void loadMedia(); }}
        uploading={uploading}
        initialSelectedUrl={post?.coverImage}
        onUpload={uploadLibraryImage}
        onInsertAtCursor={({ item, altText }: MediaPickerSelection) => insertMediaIntoPost(item as MediaItem, altText)}
        onSetAsCover={({ item }: MediaPickerSelection) => setMediaAsPostCover(item as MediaItem)}
        onError={(error) => notify('error', 'MEDIA_ACTION_FAILED', error instanceof Error ? error.message : '媒体操作失败')}
      />
      <ConfirmDialog
        open={Boolean(confirmation) && !endingSession}
        onOpenChange={(open) => { if (!open) setConfirmation(null); }}
        title={confirmation?.title || '确认操作'}
        description={confirmation?.description}
        confirmLabel={confirmation?.confirmLabel}
        confirmDisabled={endingSession || confirmation?.confirmDisabled}
        tone={confirmation?.tone}
        onConfirm={() => {
          if (endingSessionRef.current) return;
          return confirmation?.onConfirm();
        }}
        onConfirmError={(error) => {
          const message = error instanceof Error ? error.message : '操作失败';
          notify('error', 'CONFIRMED_ACTION_FAILED', message);
          return message;
        }}
      />

      {revisionsOpen && (
        <div className="fixed inset-0 z-[104] flex justify-end bg-black/70" onMouseDown={(event) => { if (event.target === event.currentTarget) setRevisionsOpen(false); }}>
          <aside ref={revisionsPanelRef} role="dialog" aria-modal="true" aria-label="内容版本历史" tabIndex={-1} className="flex h-full w-full max-w-md flex-col border-l border-white/[0.08] bg-[#0b0e15]/98 shadow-2xl shadow-black/70 outline-none">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-5"><div><div className="flex items-center gap-2 text-sm font-semibold"><History size={16} className="text-indigo-300" />版本历史</div><p className="mt-1 text-xs text-zinc-500">每次手动保存前会自动创建快照</p></div><button ref={revisionsCloseRef} aria-label="关闭版本历史" onClick={() => setRevisionsOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/[0.05] hover:text-white"><X size={16} /></button></div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {revisionsState.status === 'stale' && (
                <div role="status" className={`flex items-center gap-2 border px-3 py-2.5 text-xs ${revisionsState.error ? 'border-amber-400/15 bg-amber-400/[0.05] text-amber-200' : 'border-sky-400/15 bg-sky-400/[0.05] text-sky-200'}`}>
                  <RotateCcw size={13} className={revisionsState.error ? '' : 'animate-spin'} aria-hidden="true" />
                  <span className="min-w-0 flex-1">{revisionsState.error ? '版本历史刷新失败，当前显示上次结果。' : '正在刷新版本历史，当前显示上次结果。'}</span>
                  {revisionsState.error && <button type="button" onClick={() => { void loadRevisions(); }} className="min-h-9 shrink-0 px-2 font-medium">重试</button>}
                </div>
              )}
              <InlineResourceState state={revisionsState} loadingLabel="正在读取版本…" errorTitle="版本历史加载失败" onRetry={() => { void loadRevisions(); }}>
                {revisionsState.status === 'empty' && <EmptyList>暂无历史版本，下次保存时会开始记录</EmptyList>}
                {(revisionsState.status === 'ready' || revisionsState.status === 'stale') && revisions.map((revision) => (
                  <div key={revision.id} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-4 transition hover:border-white/[0.12]">
                    <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-zinc-200">{new Date(revision.createdAt).toLocaleString('zh-CN')}</p><p className="mt-1 text-xs text-zinc-500">{revision.reason || '手动保存前快照'}</p></div><span className="rounded-md bg-white/[0.04] px-2 py-1 text-xs text-zinc-500">#{revision.id}</span></div>
                    {revision.summary && <div className="mt-3 grid grid-cols-4 gap-1.5 text-center"><span className="rounded-md bg-black/20 px-1 py-2 text-xs text-zinc-500"><strong className="block text-sm text-zinc-300">{revision.summary.posts}</strong>文章</span><span className="rounded-md bg-black/20 px-1 py-2 text-xs text-zinc-500"><strong className="block text-sm text-amber-300">{revision.summary.drafts}</strong>草稿</span><span className="rounded-md bg-black/20 px-1 py-2 text-xs text-zinc-500"><strong className="block text-sm text-zinc-300">{revision.summary.projects}</strong>项目</span><span className="rounded-md bg-black/20 px-1 py-2 text-xs text-zinc-500"><strong className="block text-sm text-zinc-300">{formatBytes(revision.summary.sizeBytes)}</strong>大小</span></div>}
                    <button disabled={saveBlocked} onClick={() => { if (saveBlockedRef.current) return; setRevisionsOpen(false); setConfirmation({ title: '载入该历史版本？', description: '历史内容只会载入编辑器，不会立即保存。当前未保存内容将被替换。', confirmLabel: '载入版本', tone: 'warning', onConfirm: () => loadRevisionIntoEditor(revision) }); }} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/[0.07] px-3 text-xs text-zinc-400 transition hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw size={14} />载入到编辑器</button>
                  </div>
                ))}
              </InlineResourceState>
            </div>
          </aside>
        </div>
      )}

      {sidebarOpen && <button aria-label="关闭导航" className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside ref={sidebarPanelRef} id="admin-sidebar" data-collapsed={sidebarCollapsed} role={sidebarIsModal ? 'dialog' : undefined} aria-modal={sidebarIsModal ? true : undefined} aria-label="后台主导航" tabIndex={-1} className={`fixed inset-y-0 left-0 z-50 flex w-[256px] flex-col overflow-hidden border-r border-white/[0.07] bg-[#090b10] shadow-2xl shadow-black/40 transition-[width,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:visible lg:translate-x-0 lg:shadow-none ${sidebarCollapsed ? 'lg:w-[80px]' : 'lg:w-[256px]'} ${sidebarOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}>
        <div className="flex h-[72px] shrink-0 items-center justify-between overflow-hidden border-b border-white/[0.06] px-5">
          <div className="flex shrink-0 items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg border border-indigo-400/25 bg-indigo-500/10 text-indigo-200">
              <Sparkles size={17} />
            </div>
            <div className="admin-sidebar-copy shrink-0 whitespace-nowrap"><p className="text-sm font-semibold">作品集后台</p><p className="mt-0.5 text-xs text-zinc-500">Beta-Demo777</p></div>
          </div>
          <button ref={sidebarCloseRef} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/[0.05] hover:text-white lg:hidden"><X size={17} /></button>
        </div>

        <nav className="flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-3 py-4 [scrollbar-width:thin] [scrollbar-color:#27272a_transparent]">
          {navigationGroups.map((group) => (
            <div key={group.label}>
              <p className="admin-sidebar-copy mb-1.5 whitespace-nowrap px-3 text-xs font-medium text-zinc-600">{group.label}</p>
              <div className="space-y-1">
                {group.items.map((entry) => {
                  const Icon = entry.icon;
                  const active = activeSection === entry.key;
                  return (
                    <button key={entry.key} aria-label={entry.label} title={sidebarCollapsed ? entry.label : undefined} aria-current={active ? 'page' : undefined} onClick={() => openSection(entry.key)} className={`group flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-lg px-3 text-left text-sm transition-colors ${active ? 'bg-white/[0.07] text-white' : 'text-zinc-500 hover:bg-white/[0.035] hover:text-zinc-200'}`}>
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition ${active ? 'bg-indigo-400/10 text-indigo-300' : 'text-zinc-600 group-hover:text-zinc-300'}`}><Icon size={16} /></span>
                      <span className="admin-sidebar-copy min-w-0 shrink-0 truncate whitespace-nowrap font-medium">{entry.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 overflow-hidden border-t border-white/[0.06] p-3">
          <a href="/" target="_blank" rel="noreferrer" aria-label="查看公开站点" title={sidebarCollapsed ? '查看公开站点' : undefined} className="group flex min-h-11 items-center justify-between overflow-hidden rounded-lg px-3 text-sm text-zinc-500 transition-colors hover:bg-white/[0.035] hover:text-white"><span className="flex shrink-0 items-center gap-2.5"><Globe2 size={15} className="shrink-0" /><span className="admin-sidebar-copy shrink-0 whitespace-nowrap">查看公开站点</span></span><ExternalLink size={13} className="admin-sidebar-copy admin-sidebar-copy-muted shrink-0" /></a>
          <button aria-label="退出登录" title={sidebarCollapsed ? '退出登录' : undefined} onClick={logout} className="mt-1 flex min-h-11 w-full items-center gap-2.5 overflow-hidden rounded-lg px-3 text-left text-sm text-zinc-600 transition-colors hover:bg-rose-500/[0.06] hover:text-rose-300"><LogOut size={15} className="shrink-0" /><span className="admin-sidebar-copy shrink-0 whitespace-nowrap">退出登录</span></button>
        </div>
      </aside>

      <div id="admin-shell" className={`relative min-h-screen transition-[padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${sidebarCollapsed ? 'lg:pl-[80px]' : 'lg:pl-[256px]'}`}>
        <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-white/[0.07] bg-[#07080c]/95 px-4 sm:px-6 xl:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button aria-label="打开导航" aria-expanded={sidebarOpen} aria-controls="admin-sidebar" onClick={() => setSidebarOpen(true)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/[0.08] text-zinc-400 transition hover:bg-white/[0.04] hover:text-white lg:hidden"><Menu size={18} /></button>
            <button
              type="button"
              aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="admin-sidebar"
              title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
              onClick={() => setSidebarCollapsed((current) => !current)}
              className="hidden h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/[0.08] text-zinc-400 transition hover:bg-white/[0.04] hover:text-white lg:grid"
            >
              <span className="relative h-[18px] w-[18px]" aria-hidden="true">
                <PanelLeftClose size={18} className={`absolute inset-0 transition-[opacity,transform] duration-150 ${sidebarCollapsed ? 'scale-75 opacity-0' : 'scale-100 opacity-100 delay-100'}`} />
                <PanelLeftOpen size={18} className={`absolute inset-0 transition-[opacity,transform] duration-150 ${sidebarCollapsed ? 'scale-100 opacity-100 delay-100' : 'scale-75 opacity-0'}`} />
              </span>
            </button>
            <div className="hidden h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/[0.07] text-zinc-400 sm:grid"><ActiveIcon size={17} /></div>
            <div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold sm:text-base">{activeNavigation.label}</h1>{isDirty && <span className="rounded bg-amber-400/[0.1] px-1.5 py-0.5 text-xs text-amber-300">未保存</span>}</div><p className="mt-0.5 hidden truncate text-xs text-zinc-500 sm:block">{activeNavigation.description}</p></div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <div role="status" aria-live="polite" className={`hidden items-center gap-2 rounded-md border px-3 py-1.5 text-xs md:flex ${autoBackupUnavailable ? 'border-rose-400/15 bg-rose-400/[0.06] text-rose-200' : isDirty ? 'border-amber-400/15 bg-amber-400/[0.06] text-amber-300' : 'border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-300'}`}>
              {autoBackupUnavailable ? <CircleAlert size={12} /> : isDirty ? <Cloud size={12} /> : <CheckCircle2 size={12} />}
              {autoBackupUnavailable ? isDirty ? '本地备份不可用，请手动保存' : '本地备份不可用，旧备份可能仍保留' : isDirty ? autoBackupAt ? `${autoBackupAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已本地备份` : `${changedSections.length} 个分区未保存` : lastSavedAt ? `${lastSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已保存` : '内容已保存'}
            </div>
            <button aria-label="打开快捷命令" title="快捷命令 (Cmd/Ctrl + K)" onClick={() => setCommandPaletteOpen(true)} disabled={commandPaletteBlocked} className="hidden min-h-11 items-center gap-2 rounded-lg border border-white/[0.08] px-3 text-xs text-zinc-500 transition hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 xl:flex"><Command size={14} /><kbd className="text-xs text-zinc-500">⌘K</kbd></button>
            <button aria-label="打开版本历史" title="版本历史" disabled={saveBlocked} onClick={() => { if (!saveBlockedRef.current) setRevisionsOpen(true); }} className="grid h-11 w-11 place-items-center rounded-lg border border-white/[0.08] text-zinc-500 transition hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"><History size={15} /></button>
            <button onClick={() => setPreviewOpen(true)} className="hidden min-h-11 items-center gap-2 rounded-lg border border-white/[0.08] px-3.5 text-xs text-zinc-400 transition hover:bg-white/[0.04] hover:text-white sm:flex"><Eye size={15} />实时预览</button>
            <button title={saveBlocked ? '请先处理本地草稿选择或保存冲突' : isDirty ? activeSection === 'blogPosts' && post ? '保存当前文章，并一并同步其他待保存更改' : `保存 ${changedSections.length} 个已修改内容分区` : '当前没有待保存更改'} onClick={() => void (activeSection === 'blogPosts' && post ? handleArticlePrimaryAction() : save())} disabled={saving || !isDirty || saveBlocked} className="flex min-h-11 items-center gap-2 rounded-lg bg-indigo-500 px-3.5 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40 sm:px-4"><Save size={15} />{saving ? '保存中…' : activeSection === 'blogPosts' && post ? articlePrimaryLabel : <><span className="hidden sm:inline">保存全部更改</span><span className="sm:hidden">保存</span></>}</button>
          </div>
        </header>

        {notice && <AdminNoticeToast notice={notice} onDismiss={() => setNotice(null)} />}

        {autoBackupUnavailable && (
          <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-40 flex items-start gap-2 rounded-lg border border-rose-400/20 bg-[#221015] px-3.5 py-3 text-xs leading-relaxed text-rose-200 shadow-xl md:hidden">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span>{isDirty ? '本地自动备份不可用，请及时手动保存更改。' : '本地备份存储不可用，旧备份可能仍保留。'}</span>
          </div>
        )}

        {editorFocusMode && post && (
          <section ref={focusEditorPanelRef} role="dialog" aria-modal="true" aria-label="专注写作模式" tabIndex={-1} className="fixed inset-0 z-[103] flex flex-col bg-[#07080c] outline-none">
            <header className="flex min-h-16 flex-wrap items-center gap-2 border-b border-white/[0.07] bg-[#0b0e15] px-4 py-3 sm:px-6"><div className="mr-auto min-w-0"><p className="truncate text-sm font-semibold">{post.title || '未命名文章'}</p><p className="mt-0.5 text-xs text-zinc-500">专注写作模式 · {isPostDirty ? '当前文章有未保存更改' : '当前文章已保存'}</p></div><div className="flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.02] p-1"><button aria-label="插入标题" onClick={() => insertMarkdown('## ', '', '标题')} className="grid h-11 w-11 place-items-center rounded text-zinc-500 hover:bg-white/[0.05] hover:text-white"><Heading2 size={14} /></button><button aria-label="插入粗体" onClick={() => insertMarkdown('**', '**')} className="grid h-11 w-11 place-items-center rounded text-zinc-500 hover:bg-white/[0.05] hover:text-white"><Bold size={14} /></button><button aria-label="插入链接" onClick={() => insertMarkdown('[', '](https://)', '链接文本')} className="grid h-11 w-11 place-items-center rounded text-zinc-500 hover:bg-white/[0.05] hover:text-white"><Link2 size={14} /></button><button aria-label="插入代码块" onClick={() => insertMarkdown('```\n', '\n```', '代码')} className="grid h-11 w-11 place-items-center rounded text-zinc-500 hover:bg-white/[0.05] hover:text-white"><Code2 size={14} /></button></div><button onClick={() => void handleArticlePrimaryAction()} disabled={!isDirty || saving || saveBlocked} className="flex min-h-11 items-center gap-2 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white disabled:opacity-40"><Save size={14} />{saving ? '保存中…' : articlePrimaryLabel}</button><button ref={focusEditorCloseRef} onClick={() => setEditorFocusMode(false)} className="flex min-h-11 items-center gap-2 rounded-md border border-white/[0.08] px-3 text-xs text-zinc-400 hover:bg-white/[0.04] hover:text-white"><X size={14} />退出</button></header>
            <div className="grid min-h-0 flex-1 lg:grid-cols-2"><div className="min-h-0 border-r border-white/[0.07] p-4 sm:p-6"><textarea ref={focusMarkdownEditorRef} aria-label="专注写作正文" value={post.content} onChange={(event) => updatePost({ content: event.target.value, readTime: estimateReadTime(event.target.value) })} className="h-full min-h-[45vh] w-full resize-none bg-transparent font-mono text-sm leading-7 text-zinc-200 outline-none placeholder:text-zinc-700" /></div><div className="min-h-0 overflow-y-auto bg-[#0b0d13] p-5 sm:p-8"><div className="mx-auto max-w-3xl">{post.coverImage && <img src={post.coverImage} alt={post.title} className="mb-7 max-h-72 w-full rounded-md object-cover" />}<MarkdownPreview content={post.content} /></div></div></div>
          </section>
        )}

        <main className={`w-full ${activeSection === 'blogPosts' ? 'flex h-[calc(100dvh-72px)] min-h-0 flex-col overflow-hidden' : ''}`}>
          {saveConflict && (
            <section aria-labelledby="save-conflict-title" className="m-4 flex shrink-0 flex-col gap-3 border border-amber-400/20 bg-amber-400/[0.055] px-4 py-3.5 sm:m-6 lg:flex-row lg:items-center">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-400/10 text-amber-200"><CircleAlert size={16} aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <h2 id="save-conflict-title" className="text-sm font-medium text-amber-100">检测到保存冲突</h2>
                <p className="mt-1 text-xs leading-5 text-amber-100/65">
                  {!saveConflict.serverContent
                    ? `本地草稿已保留于 ${new Date(saveConflict.detectedAt).toLocaleString('zh-CN')}。请先加载服务器版本，当前编辑内容不会被静默丢弃。`
                    : saveConflict.conflicts.length === 0
                      ? '已自动合并服务器和本地的不重叠修改。请检查编辑器后保存合并结果。'
                      : saveConflict.resolution === null
                        ? `已保留双方的不重叠修改；${saveConflict.conflicts.length} 个同字段冲突尚未选择，保存功能已暂停。`
                        : `已保留双方的不重叠修改；${saveConflict.conflicts.length} 个同字段冲突已明确采用${saveConflict.resolution === 'local' ? '本地' : '服务器'}值。`}
                </p>
                {saveConflict.serverContent && saveConflict.conflicts.length > 0 && (
                  <p className="mt-1 truncate text-xs text-amber-100/50" title={saveConflict.conflicts.join('、')}>
                    冲突字段：{saveConflict.conflicts.join('、')}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {!saveConflict.serverContent && (
                  <button type="button" disabled={conflictResolving} onClick={() => { void loadServerVersionForConflict(); }} className="min-h-11 rounded-lg bg-amber-200 px-3 text-xs font-medium text-amber-950 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60">
                    {conflictResolving ? '加载中…' : '加载服务器版本'}
                  </button>
                )}
                {saveConflict.serverContent && (
                  <>
                    {saveConflict.conflicts.length > 0 && (
                      <>
                        <button type="button" aria-pressed={saveConflict.resolution === 'server'} onClick={() => { void chooseConflictResolution('server'); }} className={`min-h-11 rounded-lg border px-3 text-xs transition ${saveConflict.resolution === 'server' ? 'border-amber-200/60 bg-amber-200/10 text-amber-100' : 'border-white/[0.09] text-zinc-300 hover:bg-white/[0.04]'}`}>冲突字段采用服务器值</button>
                        <button type="button" aria-pressed={saveConflict.resolution === 'local'} onClick={() => { void chooseConflictResolution('local'); }} className={`min-h-11 rounded-lg border px-3 text-xs transition ${saveConflict.resolution === 'local' ? 'border-amber-200/60 bg-amber-200/10 text-amber-100' : 'border-white/[0.09] text-zinc-300 hover:bg-white/[0.04]'}`}>冲突字段采用本地值</button>
                      </>
                    )}
                    <button type="button" onClick={() => setConfirmation({ title: '完全采用服务器版本？', description: '所有本地冲突草稿都会被丢弃；服务器版本将保持不变。', confirmLabel: '采用并丢弃草稿', tone: 'warning', onConfirm: acceptConflictServerVersion })} className="min-h-11 rounded-lg border border-white/[0.09] px-3 text-xs text-zinc-300 hover:bg-white/[0.04]">完全采用服务器版本</button>
                    <button type="button" disabled={saving || saveBlockedByConflict} onClick={() => { void save(content, { successMessage: '冲突内容已合并并基于最新服务器版本保存' }); }} className="min-h-11 rounded-lg bg-amber-200 px-3 text-xs font-medium text-amber-950 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60">{saving ? '保存中…' : saveBlockedByConflict ? '请先选择冲突版本' : '保存合并结果'}</button>
                  </>
                )}
              </div>
            </section>
          )}
          {localDraft && (
            <div className="m-4 flex shrink-0 flex-col gap-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.055] px-4 py-3.5 sm:m-6 sm:flex-row sm:items-center">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-400/10 text-amber-300"><Cloud size={16} /></span>
              <div className="min-w-0 flex-1"><p className="text-sm font-medium text-amber-100">本地草稿需要明确选择</p><p className="mt-1 text-xs text-amber-200/60">保存于 {new Date(localDraft.savedAt).toLocaleString('zh-CN')}。该草稿没有可信的合并基础，只能整份保留服务器版本或整份采用本地内容。</p></div>
              <div className="flex flex-wrap gap-2"><button disabled={draftChoiceResolving} onClick={() => { if (!draftChoiceResolving) void discardLocalDraft(); }} className="min-h-11 rounded-lg px-3 text-xs text-zinc-300 transition hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-40">{draftChoiceResolving ? '处理中…' : '保留服务器版本'}</button><button disabled={draftChoiceResolving} onClick={() => { if (!draftChoiceResolving) requestRestoreLocalDraft(); }} className="min-h-11 rounded-lg bg-amber-300 px-3 text-xs font-medium text-amber-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50">{draftChoiceResolving ? '处理中…' : '采用整个本地草稿'}</button></div>
            </div>
          )}
          <section id="admin-workspace" inert={saveBlocked ? true : undefined} aria-disabled={saveBlocked || undefined} className={activeSection === 'blogPosts' ? 'min-h-0 min-w-0 flex-1' : `min-h-[calc(100dvh-72px)] ${activeSection === 'projects' ? '' : 'p-4 sm:p-6 xl:p-8'}`}>

            {activeSection === 'overview' && (
              <div className="space-y-8">
                <div className="flex flex-col gap-5 border-b border-white/[0.08] pb-7 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-sm text-zinc-500">欢迎回来，{content.personalInfo.name || 'Beta-Demo777'}</p>
                    <h2 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">今天要处理的内容</h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">继续未完成的文章，补齐发布信息，并在离开前保存本次更改。</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={addPost} className="flex min-h-11 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-zinc-200"><FilePlus2 size={16} />新建草稿</button>
                    <button onClick={() => setPreviewOpen(true)} className="flex min-h-11 items-center gap-2 rounded-lg border border-white/10 px-4 text-sm text-zinc-300 transition hover:bg-white/[0.05] hover:text-white"><Eye size={16} />实时预览</button>
                  </div>
                </div>

                <div className="grid overflow-hidden rounded-lg border border-white/[0.08] sm:grid-cols-3 sm:divide-x sm:divide-white/[0.08]">
                  <button onClick={() => { setPostStatusFilter('draft'); openSection('blogPosts'); }} className="flex min-h-24 items-center justify-between border-b border-white/[0.08] px-5 text-left transition hover:bg-white/[0.025] sm:border-b-0"><span><span className="block text-sm font-medium text-zinc-200">待完成草稿</span><span className="mt-1 block text-xs text-zinc-500">继续写作和检查</span></span><strong className="text-2xl font-semibold text-amber-300">{draftPosts}</strong></button>
                  <button onClick={() => openSection('blogPosts')} className="flex min-h-24 items-center justify-between border-b border-white/[0.08] px-5 text-left transition hover:bg-white/[0.025] sm:border-b-0"><span><span className="block text-sm font-medium text-zinc-200">内容待补齐</span><span className="mt-1 block text-xs text-zinc-500">标题、正文、摘要或封面</span></span><strong className="text-2xl font-semibold text-rose-300">{postsNeedingAttention.length}</strong></button>
                  <button onClick={() => { if (isDirty) void save(); }} disabled={!isDirty || saving || saveBlocked} className="flex min-h-24 items-center justify-between px-5 text-left transition hover:bg-white/[0.025] disabled:cursor-default"><span><span className="block text-sm font-medium text-zinc-200">待保存更改</span><span className="mt-1 block text-xs text-zinc-500">{isDirty ? saveBlocked ? '请先处理草稿选择或保存冲突' : '点击保存全部内容' : '当前内容已保存'}</span></span><strong className={`text-2xl font-semibold ${isDirty ? 'text-indigo-300' : 'text-emerald-300'}`}>{changedSections.length}</strong></button>
                </div>

                <div className="grid gap-8 xl:grid-cols-2">
                  <section aria-labelledby="drafts-heading" className="min-w-0">
                    <div className="mb-3 flex min-h-11 items-center justify-between border-b border-white/[0.08]"><div><h3 id="drafts-heading" className="text-sm font-semibold text-white">继续编辑草稿</h3><p className="mt-1 text-xs text-zinc-500">按最近日期排列</p></div><button onClick={() => { setPostStatusFilter('draft'); openSection('blogPosts'); }} className="min-h-11 px-2 text-xs text-indigo-300 transition hover:text-indigo-200">查看全部</button></div>
                    <div className="divide-y divide-white/[0.07]">
                      {draftPostEntries.length === 0 && <EmptyList>暂无草稿，可以新建一篇文章</EmptyList>}
                      {draftPostEntries.map(({ item, index }) => <button key={item.id} onClick={() => openPostEditor(index)} className="group flex min-h-16 w-full items-center gap-3 px-2 text-left transition hover:bg-white/[0.025]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-amber-400/[0.07] text-amber-300"><FileText size={15} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-300 group-hover:text-white">{item.title || '未命名文章'}</span><span className="mt-1 block text-xs text-zinc-500">{item.category || '未分类'} · {item.date}</span></span><ChevronRight size={15} className="text-zinc-600" /></button>)}
                    </div>
                  </section>

                  <section aria-labelledby="recent-heading" className="min-w-0">
                    <div className="mb-3 flex min-h-11 items-center justify-between border-b border-white/[0.08]"><div><h3 id="recent-heading" className="text-sm font-semibold text-white">最近文章</h3><p className="mt-1 text-xs text-zinc-500">快速回到最近维护的内容</p></div><button onClick={() => openSection('blogPosts')} className="min-h-11 px-2 text-xs text-indigo-300 transition hover:text-indigo-200">查看全部</button></div>
                    <div className="divide-y divide-white/[0.07]">
                      {recentPosts.length === 0 && <EmptyList>暂无文章，可以从新建草稿开始</EmptyList>}
                      {recentPosts.map(({ item, index }) => <button key={item.id} onClick={() => openPostEditor(index)} className="group flex min-h-16 w-full items-center gap-3 px-2 text-left transition hover:bg-white/[0.025]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/[0.035] text-zinc-500 group-hover:text-indigo-300"><FileText size={15} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-300 group-hover:text-white">{item.title || '未命名文章'}</span><span className="mt-1 block text-xs text-zinc-500">{item.category || '未分类'} · {item.date}</span></span><span className={`rounded-full px-2 py-1 text-xs ${item.status === 'draft' ? 'bg-amber-400/[0.08] text-amber-300' : 'bg-emerald-400/[0.08] text-emerald-300'}`}>{item.status === 'draft' ? '草稿' : '已发布'}</span></button>)}
                    </div>
                  </section>
                </div>
              </div>
            )}

            {activeSection === 'media' && (
              <div className="space-y-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div><h2 className="text-xl font-semibold">媒体资源库</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">集中查看、复用和管理博客图片。被内容引用的图片会受到删除保护。</p></div>
                  <label aria-disabled={uploading || saveBlocked} className={`flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-sm font-medium transition ${uploading || saveBlocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-indigo-400'}`}><Upload size={16} />{uploading ? '上传中…' : '上传图片'}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" disabled={uploading || saveBlocked} onChange={(event) => { if (!saveBlockedRef.current) void uploadLibraryImage(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>
                </div>

                <div className="flex flex-col gap-3 rounded-lg border border-white/[0.07] bg-[#10131a]/65 p-3 sm:flex-row sm:items-center">
                  <div className="relative flex-1"><Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600" /><input type="search" aria-label="搜索媒体资源" value={mediaSearch} onChange={(event) => setMediaSearch(event.target.value)} placeholder="搜索文件名…" className={`${inputClass} py-2.5 pl-9`} /></div>
                  <div className="flex items-center gap-3 px-2 text-xs text-zinc-500"><span>{mediaItems.length} 个文件</span><span className="h-3 w-px bg-white/[0.08]" /><span>{formatBytes(mediaItems.reduce((total, item) => total + item.sizeBytes, 0))}</span><button onClick={() => void loadMedia()} className="grid h-11 w-11 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/[0.04] hover:text-white" aria-label="刷新媒体资源"><RotateCcw size={14} /></button></div>
                </div>

                {mediaState.status === 'stale' && (
                  <div role="status" className={`flex items-center gap-2 border px-3 py-2.5 text-xs ${mediaState.error ? 'border-amber-400/15 bg-amber-400/[0.05] text-amber-200' : 'border-sky-400/15 bg-sky-400/[0.05] text-sky-200'}`}>
                    <RotateCcw size={13} className={mediaState.error ? '' : 'animate-spin'} aria-hidden="true" />
                    <span className="min-w-0 flex-1">{mediaState.error ? '媒体刷新失败，当前显示上次结果。' : '正在刷新媒体，当前显示上次结果。'}</span>
                    {mediaState.error && <button type="button" onClick={() => { void loadMedia(); }} className="min-h-9 shrink-0 px-2 font-medium">重试</button>}
                  </div>
                )}
                <InlineResourceState state={mediaState} loadingLabel="正在读取媒体资源…" errorTitle="媒体资源加载失败" onRetry={() => { void loadMedia(); }}>
                  {(mediaState.status === 'empty' || ((mediaState.status === 'ready' || mediaState.status === 'stale') && filteredMediaItems.length === 0)) && <EmptyList>{mediaSearch ? '没有匹配的图片' : '暂无媒体资源，点击右上角上传第一张图片'}</EmptyList>}
                  {(mediaState.status === 'ready' || mediaState.status === 'stale') && filteredMediaItems.length > 0 && (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {filteredMediaItems.map((item) => (
                        <article key={item.filename} className="group overflow-hidden rounded-lg border border-white/[0.07] bg-[#10131a]/65 transition hover:border-white/[0.13]">
                          <div className="relative aspect-[16/10] overflow-hidden bg-black/30"><img src={item.url} alt={item.filename} loading="lazy" className="h-full w-full object-cover" />{item.referenced && <span className="absolute right-2 top-2 rounded-md border border-emerald-400/15 bg-[#0d1d18]/95 px-2 py-1 text-xs text-emerald-300">使用中</span>}</div>
                          <div className="p-4"><p className="truncate text-sm font-medium text-zinc-200" title={item.filename}>{item.filename}</p><div className="mt-2 flex items-center justify-between text-xs text-zinc-500"><span>{item.contentType.replace('image/', '').toUpperCase()} · {formatBytes(item.sizeBytes)}</span><span>{new Date(item.uploadedAt).toLocaleDateString('zh-CN')}</span></div>{item.references.length > 0 && <p className="mt-2 truncate text-xs text-emerald-300/70" title={item.references.join('、')}>{item.references.join('、')}</p>}
                            <div className="mt-4 grid grid-cols-3 gap-1.5"><button onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}${item.url}`); notify('success', 'MEDIA_URL_COPIED', '图片地址已复制'); }} className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-white/[0.06] px-1 text-xs text-zinc-500 transition hover:bg-white/[0.04] hover:text-white"><Copy size={13} />复制</button><button disabled={saveBlocked} onClick={() => { if (!saveBlockedRef.current) insertMediaIntoPost(item); }} className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-white/[0.06] px-1 text-xs text-zinc-500 transition hover:bg-indigo-400/[0.06] hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-30"><ImagePlus size={13} />插入</button><button disabled={item.referenced || saveBlocked} title={item.referenced ? '该图片正被内容引用' : saveBlocked ? '请先处理本地草稿或保存冲突' : '删除图片'} onClick={() => { if (saveBlockedRef.current) return; setConfirmation({ title: '删除这张图片？', description: '删除后无法恢复，历史版本中的图片链接也可能失效。', confirmLabel: '删除图片', onConfirm: () => deleteMedia(item) }); }} className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-white/[0.06] px-1 text-xs text-rose-400 transition hover:bg-rose-400/[0.06] disabled:cursor-not-allowed disabled:opacity-30"><Trash2 size={13} />删除</button></div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </InlineResourceState>
              </div>
            )}

          {activeSection === 'personalInfo' && (
            <div className="space-y-8">
              <div className="space-y-5">
                <h2 className="font-semibold">个人资料</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {(['name', 'title', 'location', 'email', 'github', 'twitter'] as const).map((key) => <div key={key}><Field label={key}><input className={inputClass} value={content.personalInfo[key]} onChange={(event) => setContent((current) => ({ ...current, personalInfo: { ...current.personalInfo, [key]: event.target.value } }))} /></Field></div>)}
                  <div className="md:col-span-2"><Field label="个人简介"><textarea className={`${inputClass} min-h-28`} value={content.personalInfo.bio} onChange={(event) => setContent((current) => ({ ...current, personalInfo: { ...current.personalInfo, bio: event.target.value } }))} /></Field></div>
                </div>
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between">
                  <div><h3 className="text-sm font-semibold">工作经历</h3><p className="mt-1 text-xs text-zinc-500">对应前台“关于我”中的工作经历时间线</p></div>
                  <button onClick={() => setContent((current) => ({ ...current, personalInfo: { ...current.personalInfo, experience: [...current.personalInfo.experience, { year: '', role: '新工作经历', desc: '' }] } }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加经历</button>
                </div>
                {content.personalInfo.experience.length === 0 && <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-xs text-zinc-500">暂无工作经历，点击右上角添加</p>}
                {content.personalInfo.experience.map((experience, index) => (
                  <div key={index} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-[160px_1fr_auto]">
                    <Field label="时间范围"><input className={inputClass} value={experience.year} onChange={(event) => updateExperience(index, { year: event.target.value })} placeholder="例如：2024 - 至今" /></Field>
                    <div className="grid gap-3">
                      <Field label="职位 / 公司"><input className={inputClass} value={experience.role} onChange={(event) => updateExperience(index, { role: event.target.value })} /></Field>
                      <Field label="工作内容与成果"><textarea className={`${inputClass} min-h-20`} value={experience.desc} onChange={(event) => updateExperience(index, { desc: event.target.value })} /></Field>
                    </div>
                    <button title="删除经历" aria-label={`删除经历 ${experience.role || index + 1}`} onClick={() => setContent((current) => ({ ...current, personalInfo: { ...current.personalInfo, experience: current.personalInfo.experience.filter((_, itemIndex) => itemIndex !== index) } }))} className="self-start p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'siteSettings' && (
            <div className="space-y-8">
              <div className="space-y-4">
                <h2 className="font-semibold">全局设置</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="浏览器标题 / SEO 标题"><input className={inputClass} value={content.siteSettings.siteTitle} onChange={(event) => updateSiteSettings((value) => ({ ...value, siteTitle: event.target.value }))} /></Field>
                  <Field label="站点描述"><input className={inputClass} value={content.siteSettings.siteDescription} onChange={(event) => updateSiteSettings((value) => ({ ...value, siteDescription: event.target.value }))} /></Field>
                  <Field label="品牌缩写"><input className={inputClass} value={content.siteSettings.brandInitials} onChange={(event) => updateSiteSettings((value) => ({ ...value, brandInitials: event.target.value }))} /></Field>
                  <Field label="页脚版权文案"><input className={inputClass} value={content.siteSettings.footerCopyright} onChange={(event) => updateSiteSettings((value) => ({ ...value, footerCopyright: event.target.value }))} placeholder="支持 {year} 与 {name}" /></Field>
                  <Field label="ICP备案号"><input className={inputClass} value={content.siteSettings.icpNumber} onChange={(event) => updateSiteSettings((value) => ({ ...value, icpNumber: event.target.value }))} /></Field>
                  <Field label="ICP备案链接"><input type="url" className={inputClass} value={content.siteSettings.icpUrl} onChange={(event) => updateSiteSettings((value) => ({ ...value, icpUrl: event.target.value }))} /></Field>
                </div>
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between">
                  <div><h3 className="text-sm font-semibold">顶部导航</h3><p className="mt-1 text-xs text-zinc-500">可编辑页面入口及其显示名称</p></div>
                  <button onClick={() => updateSiteSettings((value) => ({ ...value, navigation: [...value.navigation, { id: 'home', label: '新导航' }] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加导航</button>
                </div>
                {content.siteSettings.navigation.length === 0 && <EmptyList>暂无导航项，点击右上角添加</EmptyList>}
                {content.siteSettings.navigation.map((item, index) => (
                  <div key={`${item.id}-${index}`} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-[180px_1fr_auto]">
                    <Field label="目标页面">
                      <select className={inputClass} value={item.id} onChange={(event) => updateSiteSettings((value) => ({ ...value, navigation: value.navigation.map((entry, itemIndex) => itemIndex === index ? { ...entry, id: event.target.value as PageId } : entry) }))}>
                        <option value="home">首页</option><option value="showcase">作品集</option><option value="blog">博客</option><option value="agent">智能体</option><option value="about">关于我</option>
                      </select>
                    </Field>
                    <Field label="显示名称"><input className={inputClass} value={item.label} onChange={(event) => updateSiteSettings((value) => ({ ...value, navigation: value.navigation.map((entry, itemIndex) => itemIndex === index ? { ...entry, label: event.target.value } : entry) }))} /></Field>
                    <button title="删除导航" aria-label={`删除导航 ${item.label || index + 1}`} onClick={() => updateSiteSettings((value) => ({ ...value, navigation: value.navigation.filter((_, itemIndex) => itemIndex !== index) }))} className="self-end p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">页脚徽章</h3><button onClick={() => updateSiteSettings((value) => ({ ...value, footerBadges: [...value.footerBadges, '新徽章'] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加徽章</button></div>
                {content.siteSettings.footerBadges.length === 0 && <EmptyList>暂无页脚徽章</EmptyList>}
                {content.siteSettings.footerBadges.map((badge, index) => (
                  <div key={index} className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-4">
                    <input className={inputClass} value={badge} onChange={(event) => updateSiteSettings((value) => ({ ...value, footerBadges: value.footerBadges.map((entry, itemIndex) => itemIndex === index ? event.target.value : entry) }))} />
                    <button title="删除徽章" aria-label={`删除徽章 ${badge || index + 1}`} onClick={() => updateSiteSettings((value) => ({ ...value, footerBadges: value.footerBadges.filter((_, itemIndex) => itemIndex !== index) }))} className="p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'homePage' && (
            <div className="space-y-8">
              <div className="space-y-4">
                <h2 className="font-semibold">首页内容</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="主标题前缀"><input className={inputClass} value={content.homePage.heroPrefix} onChange={(event) => updateHomePage((value) => ({ ...value, heroPrefix: event.target.value }))} /></Field>
                  <Field label="主标题高亮文字"><input className={inputClass} value={content.homePage.heroHighlight} onChange={(event) => updateHomePage((value) => ({ ...value, heroHighlight: event.target.value }))} /></Field>
                  <Field label="主标题后缀"><input className={inputClass} value={content.homePage.heroSuffix} onChange={(event) => updateHomePage((value) => ({ ...value, heroSuffix: event.target.value }))} /></Field>
                  <Field label="作品集按钮"><input className={inputClass} value={content.homePage.portfolioButton} onChange={(event) => updateHomePage((value) => ({ ...value, portfolioButton: event.target.value }))} /></Field>
                  <Field label="智能体按钮"><input className={inputClass} value={content.homePage.agentButton} onChange={(event) => updateHomePage((value) => ({ ...value, agentButton: event.target.value }))} /></Field>
                  <Field label="博客按钮"><input className={inputClass} value={content.homePage.blogButton} onChange={(event) => updateHomePage((value) => ({ ...value, blogButton: event.target.value }))} /></Field>
                  <div className="md:col-span-2"><Field label="首页介绍"><textarea className={`${inputClass} min-h-24`} value={content.homePage.introduction} onChange={(event) => updateHomePage((value) => ({ ...value, introduction: event.target.value }))} /></Field></div>
                </div>
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">轮播问候语</h3><button onClick={() => updateHomePage((value) => ({ ...value, greetings: [...value.greetings, '新的问候语'] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加问候语</button></div>
                {content.homePage.greetings.length === 0 && <EmptyList>暂无问候语</EmptyList>}
                {content.homePage.greetings.map((greeting, index) => (
                  <div key={index} className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-4"><input className={inputClass} value={greeting} onChange={(event) => updateHomePage((value) => ({ ...value, greetings: value.greetings.map((entry, itemIndex) => itemIndex === index ? event.target.value : entry) }))} /><button title="删除问候语" aria-label={`删除问候语 ${index + 1}`} onClick={() => updateHomePage((value) => ({ ...value, greetings: value.greetings.filter((_, itemIndex) => itemIndex !== index) }))} className="p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button></div>
                ))}
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">能力亮点卡片</h3><button onClick={() => updateHomePage((value) => ({ ...value, highlights: [...value.highlights, { id: `highlight-${Date.now()}`, title: '新亮点', description: '', icon: 'sparkles' }] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加卡片</button></div>
                {content.homePage.highlights.length === 0 && <EmptyList>暂无亮点卡片</EmptyList>}
                {content.homePage.highlights.map((highlight, index) => (
                  <div key={`${highlight.id}-${index}`} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                    <Field label="卡片 ID"><input className={inputClass} value={highlight.id} onChange={(event) => updateHomePage((value) => ({ ...value, highlights: value.highlights.map((entry, itemIndex) => itemIndex === index ? { ...entry, id: event.target.value } : entry) }))} /></Field>
                    <Field label="标题"><input className={inputClass} value={highlight.title} onChange={(event) => updateHomePage((value) => ({ ...value, highlights: value.highlights.map((entry, itemIndex) => itemIndex === index ? { ...entry, title: event.target.value } : entry) }))} /></Field>
                    <Field label="图标"><select className={inputClass} value={highlight.icon} onChange={(event) => updateHomePage((value) => ({ ...value, highlights: value.highlights.map((entry, itemIndex) => itemIndex === index ? { ...entry, icon: event.target.value as SiteContent['homePage']['highlights'][number]['icon'] } : entry) }))}><option value="code">Code</option><option value="layers">Layers</option><option value="sparkles">Sparkles</option></select></Field>
                    <Field label="说明"><textarea className={`${inputClass} min-h-20`} value={highlight.description} onChange={(event) => updateHomePage((value) => ({ ...value, highlights: value.highlights.map((entry, itemIndex) => itemIndex === index ? { ...entry, description: event.target.value } : entry) }))} /></Field>
                    <button onClick={() => updateHomePage((value) => ({ ...value, highlights: value.highlights.filter((_, itemIndex) => itemIndex !== index) }))} className="flex items-center gap-1 text-xs text-rose-400 md:col-span-2 md:justify-self-end"><Trash2 size={14} />删除卡片</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'showcasePage' && (
            <div className="space-y-8">
              <h2 className="font-semibold">作品集页面文案</h2>
              <div className="grid gap-4 md:grid-cols-2">
                {showcaseFields.map(([key, label]) => <div key={key}><Field label={label}><input className={inputClass} value={content.showcasePage[key]} onChange={(event) => updateShowcasePage({ [key]: event.target.value })} /></Field></div>)}
              </div>
              <div className="border-t border-white/10 pt-6"><Field label="终端 help 命令说明（每行一项）"><textarea className={`${inputClass} min-h-48 font-mono`} value={content.showcasePage.terminalHelp.join('\n')} onChange={(event) => updateShowcasePage({ terminalHelp: event.target.value.split('\n') })} /></Field></div>
            </div>
          )}

          {activeSection === 'techStackGroups' && (
            <div className="space-y-4"><div className="flex justify-between"><h2 className="font-semibold">技术栈</h2><button onClick={() => setContent((current) => ({ ...current, techStackGroups: [...current.techStackGroups, { id: `stack-${Date.now()}`, title: '新分类', items: [] }] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加分类</button></div>
              {content.techStackGroups.map((group, index) => <div key={group.id} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-[150px_180px_1fr_auto]"><Field label="分类 ID"><input className={inputClass} value={group.id} onChange={(event) => setContent((current) => ({ ...current, techStackGroups: current.techStackGroups.map((item, i) => i === index ? { ...item, id: event.target.value } : item) }))} /></Field><Field label="分类名称"><input className={inputClass} value={group.title} onChange={(event) => setContent((current) => ({ ...current, techStackGroups: current.techStackGroups.map((item, i) => i === index ? { ...item, title: event.target.value } : item) }))} /></Field><Field label="技术项（逗号分隔）"><input className={inputClass} value={group.items.join(', ')} onChange={(event) => setContent((current) => ({ ...current, techStackGroups: current.techStackGroups.map((item, i) => i === index ? { ...item, items: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } : item) }))} placeholder="使用逗号分隔技术" /></Field><button aria-label={`删除技术分类 ${group.title || group.id || index + 1}`} onClick={() => setContent((current) => ({ ...current, techStackGroups: current.techStackGroups.filter((_, i) => i !== index) }))} className="self-end p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button></div>)}
            </div>
          )}

          {activeSection === 'projects' && (
            <div className="grid min-h-[calc(100dvh-72px)] bg-[#0d1017] [&>div:last-child]:rounded-none [&>div:last-child]:border-0 xl:grid-cols-[280px_minmax(0,1fr)]">
              <div className="h-fit border-b border-white/[0.07] bg-[#10131a]/70 p-3 xl:sticky xl:top-[72px] xl:min-h-[calc(100dvh-72px)] xl:border-b-0 xl:border-r">
                <div className="flex items-center justify-between px-2 pb-3 pt-1"><div><h2 className="text-sm font-semibold">作品项目</h2><p className="mt-1 text-xs text-zinc-500">{filteredProjectEntries.length} / {content.projects.length} 个项目</p></div><button aria-label="新建项目" onClick={addProject} className="grid h-11 w-11 place-items-center rounded-lg border border-indigo-400/15 bg-indigo-400/[0.08] text-indigo-300 transition hover:bg-indigo-400/[0.14]"><Plus size={16} /></button></div>
                <div className="mb-3 space-y-2 border-y border-white/[0.06] py-3"><div className="relative"><Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" /><input type="search" aria-label="搜索作品项目" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="搜索项目…" className={`${inputClass} py-2 pl-8`} /></div><select aria-label="作品项目筛选" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value as typeof projectFilter)} className={`${inputClass} py-2`}><option value="all">全部项目</option><option value="featured">精选项目</option><option value="standard">普通项目</option></select></div>
                {selectedProjectIds.size > 0 && <div className="mb-3 rounded-lg border border-indigo-400/15 bg-indigo-400/[0.06] p-2.5"><div className="mb-2 flex items-center justify-between text-xs text-indigo-200"><span>已选 {selectedProjectIds.size} 项</span><button onClick={() => setSelectedProjectIds(new Set())} className="min-h-11 px-2 text-indigo-300/70 hover:text-indigo-200">取消</button></div><div className="grid grid-cols-3 gap-1"><button onClick={() => { setContent((current) => ({ ...current, projects: current.projects.map((item) => selectedProjectIds.has(item.id) ? { ...item, featured: true } : item) })); setSelectedProjectIds(new Set()); }} className="min-h-11 rounded-lg bg-white/[0.04] px-1 text-xs text-zinc-300 hover:bg-white/[0.07]">设为精选</button><button onClick={() => { setContent((current) => ({ ...current, projects: current.projects.map((item) => selectedProjectIds.has(item.id) ? { ...item, featured: false } : item) })); setSelectedProjectIds(new Set()); }} className="min-h-11 rounded-lg bg-white/[0.04] px-1 text-xs text-zinc-300 hover:bg-white/[0.07]">取消精选</button><button onClick={() => setConfirmation({ title: `删除已选的 ${selectedProjectIds.size} 个项目？`, description: '这些项目会先从当前编辑内容中移除，保存后才会影响公开站点。', confirmLabel: '批量删除', onConfirm: () => { setContent((current) => ({ ...current, projects: current.projects.filter((item) => !selectedProjectIds.has(item.id)) })); setSelectedProjectIds(new Set()); setSelectedProject(0); } })} className="min-h-11 rounded-lg bg-rose-400/[0.07] px-1 text-xs text-rose-300 hover:bg-rose-400/[0.12]">删除</button></div></div>}
                {filteredProjectEntries.length > 0 && <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2 px-2 text-xs text-zinc-500"><input type="checkbox" checked={filteredProjectEntries.every(({ item }) => selectedProjectIds.has(item.id))} onChange={(event) => setSelectedProjectIds((current) => { const next = new Set(current); filteredProjectEntries.forEach(({ item }) => event.target.checked ? next.add(item.id) : next.delete(item.id)); return next; })} />选择当前筛选结果</label>}
                <div className="space-y-1.5">
                  {filteredProjectEntries.length === 0 && <EmptyList>{projectSearch || projectFilter !== 'all' ? '没有匹配项目' : '暂无项目'}</EmptyList>}
                  {filteredProjectEntries.map(({ item, index }) => <div key={item.id} className={`group flex items-center rounded-lg border transition ${index === selectedProject ? 'border-indigo-400/15 bg-indigo-400/[0.09] text-white' : 'border-transparent bg-white/[0.015] text-zinc-500 hover:border-white/[0.06] hover:bg-white/[0.03] hover:text-zinc-200'}`}><label className="grid min-h-12 w-11 shrink-0 cursor-pointer place-items-center"><input type="checkbox" aria-label={`选择 ${item.title}`} checked={selectedProjectIds.has(item.id)} onChange={(event) => setSelectedProjectIds((current) => { const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} /></label><button onClick={() => setSelectedProject(index)} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 py-2.5 pr-3 text-left"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${index === selectedProject ? 'bg-indigo-400/10 text-indigo-300' : 'bg-white/[0.03] text-zinc-600'}`}><FolderKanban size={14} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-1 block truncate text-xs opacity-70">{item.year || '未设置年份'} · {item.role || '未设置角色'}</span></span>{item.featured && <Sparkles size={13} className="shrink-0 text-amber-300" />}</button></div>)}
                </div>
              </div>
              {project && <div className="rounded-lg border border-white/[0.07] bg-[#10131a]/55 p-5 sm:p-6"><div className="mb-6 flex items-center justify-between border-b border-white/[0.06] pb-5"><div><p className="text-xs text-indigo-300/80">项目详情</p><h2 className="mt-1.5 text-lg font-semibold">{project.title || '未命名项目'}</h2></div><span className={`rounded-md px-2.5 py-1 text-xs ${project.featured ? 'bg-amber-400/[0.08] text-amber-300' : 'bg-white/[0.04] text-zinc-500'}`}>{project.featured ? '精选项目' : '普通项目'}</span></div><div className="grid gap-4 md:grid-cols-2"><Field label="标题"><input className={inputClass} value={project.title} onChange={(e) => updateProject({ title: e.target.value })} /></Field><Field label="唯一 ID"><input className={inputClass} value={project.id} onChange={(e) => updateProject({ id: e.target.value })} /></Field><Field label="年份"><input className={inputClass} value={project.year} onChange={(e) => updateProject({ year: e.target.value })} /></Field><Field label="角色"><input className={inputClass} value={project.role} onChange={(e) => updateProject({ role: e.target.value })} /></Field><Field label="项目地址"><input className={inputClass} value={project.url || ''} onChange={(e) => updateProject({ url: e.target.value })} /></Field><Field label="GitHub"><input className={inputClass} value={project.github || ''} onChange={(e) => updateProject({ github: e.target.value })} /></Field><Field label="GitHub Stars"><input type="number" min="0" className={inputClass} value={project.stats.stars ?? ''} onChange={(e) => updateProject({ stats: { ...project.stats, stars: optionalNumber(e.target.value) } })} /></Field><Field label="GitHub Forks"><input type="number" min="0" className={inputClass} value={project.stats.forks ?? ''} onChange={(e) => updateProject({ stats: { ...project.stats, forks: optionalNumber(e.target.value) } })} /></Field><Field label="影响指标"><input className={inputClass} value={project.stats.impact || ''} onChange={(e) => updateProject({ stats: { ...project.stats, impact: e.target.value } })} placeholder="例如：60 FPS @ 100k particles" /></Field><Field label="标签（逗号分隔）"><input className={inputClass} value={project.tags.join(', ')} onChange={(e) => updateProject({ tags: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></Field><Field label="简要描述"><textarea className={`${inputClass} min-h-24`} value={project.description} onChange={(e) => updateProject({ description: e.target.value })} /></Field><Field label="详细描述"><textarea className={`${inputClass} min-h-32`} value={project.longDescription || ''} onChange={(e) => updateProject({ longDescription: e.target.value })} /></Field><div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/[0.06] pt-5 md:col-span-2"><label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-zinc-400"><input type="checkbox" checked={project.featured} onChange={(e) => updateProject({ featured: e.target.checked })} />设为精选项目</label><button onClick={() => setConfirmation({ title: `删除项目“${project.title}”？`, description: '项目会先从当前编辑内容中移除，保存后才会影响公开站点。', confirmLabel: '删除项目', onConfirm: () => { setContent((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== project.id) })); setSelectedProject(0); } })} className="flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs text-rose-400 transition hover:bg-rose-400/[0.07]"><Trash2 size={14} />删除项目</button></div></div></div>}
            </div>
          )}

          {activeSection === 'blogPage' && (
            <div className="space-y-5">
              <h2 className="font-semibold">博客列表与阅读页面文案</h2>
              <div className="grid gap-4 md:grid-cols-2">
                {blogPageFields.map(([key, label]) => (
                  <div key={key}><Field label={label}>
                    {key === 'description' ? <textarea className={`${inputClass} min-h-24`} value={content.blogPage[key]} onChange={(event) => updateBlogPage({ [key]: event.target.value })} /> : <input className={inputClass} value={content.blogPage[key]} onChange={(event) => updateBlogPage({ [key]: event.target.value })} />}
                  </Field></div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'blogPosts' && (
            <div className="grid h-full overflow-hidden bg-[#0d1017] xl:grid-cols-[256px_minmax(0,1fr)] min-[1440px]:grid-cols-[272px_minmax(0,1fr)]">
              <div className={`${postEditorOpen ? 'hidden xl:flex' : 'flex'} min-h-0 min-w-0 flex-col border-r border-white/[0.07] bg-[#0a0c11] p-3`}>
                <div className="flex items-center gap-1 px-2 pb-3 pt-1">
                  <div className="mr-auto min-w-0"><h2 className="text-sm font-semibold">博客文章</h2><p className="mt-1 text-xs text-zinc-500">{filteredPostEntries.length} / {content.blogPosts.length} 篇 · {draftPosts} 篇草稿</p></div>
                  <button type="button" aria-label={postSelectionMode ? '退出批量管理' : '批量管理文章'} aria-pressed={postSelectionMode} title={postSelectionMode ? '完成批量管理' : '批量管理'} onClick={togglePostSelectionMode} className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg border transition ${postSelectionMode ? 'border-indigo-400/25 bg-indigo-400/[0.1] text-indigo-200' : 'border-white/[0.08] text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200'}`}><ListChecks size={15} /></button>
                  <button type="button" aria-label="新建文章" title="新建文章" onClick={addPost} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-indigo-400/20 bg-indigo-400/[0.08] text-indigo-200 transition hover:bg-indigo-400/[0.14]"><FilePlus2 size={15} /></button>
                </div>
                <div className="mb-3 space-y-2 border-y border-white/[0.06] py-3">
                  <div className="relative"><Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" /><input type="search" aria-label="搜索博客文章" value={postSearch} onChange={(event) => setPostSearch(event.target.value)} placeholder="搜索标题、摘要或标签…" className={`${inputClass} py-2 pl-8`} /></div>
                  <div className="flex min-w-0 gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-3 rounded-lg border border-white/[0.08] bg-black/20 p-1" role="group" aria-label="文章状态筛选">
                      {([['all', '全部'], ['draft', '草稿'], ['published', '已发布']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={postStatusFilter === value} onClick={() => setPostStatusFilter(value)} className={`h-9 rounded-md px-1 text-xs transition ${postStatusFilter === value ? 'bg-white/[0.09] text-white' : 'text-zinc-500 hover:text-zinc-200'}`}>{label}</button>)}
                    </div>
                    <select aria-label="文章排序" value={postSort} onChange={(event) => setPostSort(event.target.value as typeof postSort)} className="h-11 w-[92px] rounded-lg border border-white/[0.1] bg-[#090b11] px-2 text-xs text-zinc-300 outline-none"><option value="newest">最新</option><option value="oldest">最早</option><option value="title">标题</option></select>
                  </div>
                </div>
                {postSelectionMode && selectedPostIds.size > 0 && <div className="mb-3 border-b border-indigo-400/15 bg-indigo-400/[0.05] p-3"><div className="mb-2 flex items-center justify-between text-xs text-indigo-100"><span>已选 {selectedPostIds.size} 篇</span><button onClick={() => setSelectedPostIds(new Set())} className="min-h-11 px-2 text-indigo-300/70 hover:text-indigo-200">取消</button></div><div className="grid grid-cols-3 gap-1.5"><button onClick={() => { setContent((current) => ({ ...current, blogPosts: current.blogPosts.map((item) => selectedPostIds.has(item.id) ? { ...item, status: 'published' } : item) })); setSelectedPostIds(new Set()); setPostSelectionMode(false); }} className="min-h-11 rounded-md bg-emerald-400/[0.08] px-1 text-xs text-emerald-300 hover:bg-emerald-400/[0.14]">标记发布</button><button onClick={() => { setContent((current) => ({ ...current, blogPosts: current.blogPosts.map((item) => selectedPostIds.has(item.id) ? { ...item, status: 'draft' } : item) })); setSelectedPostIds(new Set()); setPostSelectionMode(false); }} className="min-h-11 rounded-md bg-amber-400/[0.08] px-1 text-xs text-amber-300 hover:bg-amber-400/[0.14]">转为草稿</button><button onClick={() => setConfirmation({ title: `删除已选的 ${selectedPostIds.size} 篇文章？`, description: '这些文章会先从当前编辑内容中移除，保存全部更改后才会影响公开站点。', confirmLabel: '删除文章', onConfirm: () => { setContent((current) => ({ ...current, blogPosts: current.blogPosts.filter((item) => !selectedPostIds.has(item.id)) })); setSelectedPostIds(new Set()); setPostSelectionMode(false); setSelectedPost(0); setPostEditorOpen(false); } })} className="min-h-11 rounded-md bg-rose-400/[0.08] px-1 text-xs text-rose-300 hover:bg-rose-400/[0.14]">删除</button></div></div>}
                {postSelectionMode && filteredPostEntries.length > 0 && <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2 px-2 text-xs text-zinc-500"><input type="checkbox" checked={filteredPostEntries.every(({ item }) => selectedPostIds.has(item.id))} onChange={(event) => setSelectedPostIds((current) => { const next = new Set(current); filteredPostEntries.forEach(({ item }) => event.target.checked ? next.add(item.id) : next.delete(item.id)); return next; })} />选择当前筛选结果</label>}
                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5 [scrollbar-width:thin] [scrollbar-color:#27272a_transparent]">
                  {filteredPostEntries.length === 0 && <EmptyList>{postSearch || postStatusFilter !== 'all' ? '没有匹配文章' : '暂无文章'}</EmptyList>}
                  {filteredPostEntries.map(({ item, index }) => {
                    const issueCount = [...getPostPublishChecks(item).blocking, ...getPostPublishChecks(item).warnings].length + (isValidScheduledAt(item.scheduledAt) ? 0 : 1);
                    const scheduledAt = item.scheduledAt ? new Date(item.scheduledAt) : null;
                    const scheduled = Boolean(scheduledAt && !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now());
                    const selected = selectedPostIds.has(item.id);
                    return <div key={item.id} className={`group flex items-center border-b border-white/[0.055] transition ${index === selectedPost ? 'bg-indigo-400/[0.08]' : 'hover:bg-white/[0.025]'}`}>
                      {postSelectionMode && <label className="grid min-h-14 w-10 shrink-0 cursor-pointer place-items-center"><input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected} onChange={(event) => setSelectedPostIds((current) => { const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} /></label>}
                      <button data-post-index={index} onClick={() => postSelectionMode ? setSelectedPostIds((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; }) : openPostEditor(index)} className="flex min-h-[68px] min-w-0 flex-1 items-center gap-2.5 px-2 py-2.5 text-left">
                        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${index === selectedPost ? 'bg-indigo-400/10 text-indigo-300' : 'bg-white/[0.03] text-zinc-600'}`}><FileText size={14} /></span>
                        <span className="min-w-0 flex-1"><span className={`block truncate text-sm font-medium ${index === selectedPost ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-200'}`}>{item.title || '未命名文章'}</span><span className="mt-1 block truncate text-xs text-zinc-500">{item.category || '未分类'} · {item.date}</span></span>
                        <span className="flex shrink-0 items-center gap-1.5">{issueCount > 0 && <CircleAlert size={14} className="text-amber-300/70" aria-label={`${issueCount} 项待完善`} />}<span className={`rounded-full px-2 py-1 text-xs ${item.status === 'draft' ? 'bg-amber-400/[0.08] text-amber-300' : scheduled ? 'bg-sky-400/[0.08] text-sky-300' : 'bg-emerald-400/[0.08] text-emerald-300'}`}>{item.status === 'draft' ? '草稿' : scheduled ? '定时' : '已发布'}</span></span>
                      </button>
                    </div>;
                  })}
                </div>
              </div>
              {post ? (
                <div className={`${postEditorOpen ? 'flex' : 'hidden xl:flex'} min-h-0 min-w-0 flex-col bg-[#0d1017]`}>
                  <header className="flex min-h-16 flex-wrap items-center gap-2 border-b border-white/[0.07] px-3 py-3 sm:px-5">
                    <button
                      type="button"
                      onClick={closePostEditor}
                      className="grid h-11 w-11 place-items-center rounded-md border border-white/[0.08] text-zinc-400 hover:bg-white/[0.04] hover:text-white xl:hidden"
                      aria-label="返回文章列表"
                    >
                      <ChevronRight size={17} className="rotate-180" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-1 text-xs ${post.status === 'draft' ? 'bg-amber-400/[0.09] text-amber-300' : postIsScheduled ? 'bg-sky-400/[0.09] text-sky-300' : 'bg-emerald-400/[0.09] text-emerald-300'}`}>
                          {post.status === 'draft' ? '草稿' : postIsScheduled ? '定时发布' : '已发布'}
                        </span>
                        {isPostDirty && <span className="text-xs text-amber-300/80">当前文章有未保存更改</span>}
                      </div>
                      <p className="mt-1 truncate text-xs text-zinc-500">{post.readTime} · {post.views} 次阅读 · {autoBackupAt && isPostDirty ? `${autoBackupAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已本地备份` : lastSavedAt ? `${lastSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已保存` : '等待首次保存'}</p>
                    </div>
                    <div className="flex items-center rounded-md border border-white/[0.08] bg-black/20 p-1" role="group" aria-label="编辑器视图">
                      {([
                        ['write', '写作'],
                        ['split', '分栏'],
                        ['preview', '预览'],
                      ] as const).map(([view, label]) => (
                        <button
                          key={view}
                          type="button"
                          aria-pressed={postEditorView === view}
                          onClick={() => setPostEditorView(view)}
                          className={`h-11 rounded px-2.5 text-xs transition ${postEditorView === view ? 'bg-white/[0.09] text-white' : 'text-zinc-500 hover:text-zinc-200'} ${view === 'split' ? 'hidden sm:block' : ''}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="hidden items-center gap-2 md:flex">
                      {post.status === 'draft' && <button type="button" onClick={() => void saveCurrentPost()} disabled={saving || !isDirty || saveBlocked} className="min-h-11 rounded-md border border-white/[0.08] px-3 text-xs text-zinc-300 transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40">保存草稿</button>}
                      <button type="button" onClick={() => void (post.status === 'draft' ? publishCurrentPost() : handleArticlePrimaryAction())} disabled={saving || saveBlocked || (post.status !== 'draft' && !isDirty)} className="flex min-h-11 items-center gap-2 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"><Save size={14} />{saving ? '保存中…' : post.status === 'draft' ? postIsScheduled ? '安排发布' : '发布文章' : articlePrimaryLabel}</button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPostSettingsOpen(true)}
                      className="flex h-11 items-center gap-2 rounded-md border border-white/[0.08] px-3 text-xs text-zinc-300 hover:bg-white/[0.04] min-[1600px]:hidden"
                    >
                      <Settings2 size={15} />设置
                    </button>
                  </header>

                  <div className="grid min-h-0 flex-1 min-[1600px]:grid-cols-[minmax(720px,1fr)_280px]">
                    <div data-post-editor-scroll className="min-h-0 min-w-0 overflow-y-auto p-4 sm:p-6 xl:p-6 min-[1600px]:p-8">
                      <div className="mx-auto max-w-5xl">
                        <textarea
                          rows={1}
                          value={post.title}
                          onChange={(event) => updatePost({ title: event.target.value })}
                          placeholder="文章标题"
                          aria-label="文章标题"
                          className="min-h-14 w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-3 text-3xl font-semibold leading-tight text-white outline-none placeholder:text-zinc-700 [field-sizing:content] sm:text-4xl"
                        />
                        <div className="mb-4 mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          <span>{post.category || '未分类'}</span>
                          <span aria-hidden="true">·</span>
                          <span>{post.date}</span>
                          <span aria-hidden="true">·</span>
                          <span>{post.readTime}</span>
                        </div>

                        <div className="sticky top-0 z-20 mb-3 flex min-w-0 items-center gap-1 overflow-visible rounded-md border border-white/[0.08] bg-[#10131b]/95 p-1.5 shadow-lg shadow-black/20 backdrop-blur">
                          <button title="二级标题" aria-label="插入二级标题" onClick={() => insertMarkdown('## ', '', '标题')} className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white"><Heading2 size={15} /></button>
                          <button title="粗体" aria-label="插入粗体" onClick={() => insertMarkdown('**', '**')} className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white"><Bold size={15} /></button>
                          <button title="链接" aria-label="插入链接" onClick={() => insertMarkdown('[', '](https://)', '链接文本')} className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white"><Link2 size={15} /></button>
                          <button title="选择媒体" aria-label="打开媒体选择器" disabled={saveBlocked} onClick={() => { if (saveBlockedRef.current) return; setMediaPickerOpen(true); void loadMedia(); }} className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-indigo-400/[0.08] hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-40 max-[359px]:hidden"><Images size={15} /></button>
                          <span className="mx-1 hidden h-5 w-px shrink-0 bg-white/[0.08] md:block" />
                          <button title="斜体" aria-label="插入斜体" onClick={() => insertMarkdown('_', '_')} className="hidden h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white md:grid"><Italic size={15} /></button>
                          <button title="列表" aria-label="插入列表" onClick={() => insertMarkdown('- ', '', '列表项')} className="hidden h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white md:grid"><List size={15} /></button>
                          <button title="代码块" aria-label="插入代码块" onClick={() => insertMarkdown('```\n', '\n```', '代码')} className="hidden h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white md:grid"><Code2 size={15} /></button>
                          <button title="专注写作" aria-label="打开专注写作模式" onClick={() => setEditorFocusMode(true)} className="hidden h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white md:grid"><Maximize2 size={15} /></button>
                          <div ref={postOutlineRef} className="relative ml-auto">
                            <button ref={postOutlineButtonRef} type="button" title="文章大纲" aria-label="打开文章大纲" aria-expanded={postOutlineOpen} onClick={() => { setPostToolbarMenuOpen(false); setPostOutlineOpen((current) => !current); }} className="grid h-11 w-11 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white"><ListTree size={15} /></button>
                            {postOutlineOpen && <div className="absolute right-0 top-full z-30 mt-2 w-64 border border-white/[0.1] bg-[#0b0e15] p-2 shadow-2xl shadow-black/50">
                              <p className="px-2 py-2 text-xs font-medium text-zinc-300">文章大纲</p>
                              {postOutline.length === 0 ? <p className="px-2 pb-2 text-xs leading-5 text-zinc-600">正文中暂无一至三级标题</p> : <div className="max-h-72 overflow-y-auto">{postOutline.map((item, index) => <button key={`${item.line}-${index}`} type="button" onClick={() => { setPostOutlineOpen(false); jumpToOutlineLine(item.line); }} className="flex min-h-10 w-full items-center gap-2 px-2 text-left text-xs text-zinc-500 transition hover:bg-white/[0.04] hover:text-zinc-200" style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}><span className="w-6 shrink-0 text-zinc-700">{item.line}</span><span className="truncate">{item.text}</span></button>)}</div>}
                            </div>}
                          </div>
                          <div ref={postToolbarMenuRef} className="relative md:hidden">
                            <button ref={postToolbarMenuButtonRef} type="button" aria-label="更多编辑工具" aria-expanded={postToolbarMenuOpen} onClick={() => { setPostOutlineOpen(false); setPostToolbarMenuOpen((current) => !current); }} className="grid h-11 w-11 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-white"><MoreHorizontal size={16} /></button>
                            {postToolbarMenuOpen && <div className="absolute right-0 top-full z-30 mt-2 w-44 border border-white/[0.1] bg-[#0b0e15] p-1.5 shadow-2xl shadow-black/50">
                              <button type="button" onClick={() => { setMediaPickerOpen(true); void loadMedia(); setPostToolbarMenuOpen(false); }} className="hidden min-h-11 w-full items-center gap-3 px-3 text-left text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white max-[359px]:flex"><Images size={14} />选择媒体</button>
                              <button type="button" onClick={() => { insertMarkdown('_', '_'); setPostToolbarMenuOpen(false); }} className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white"><Italic size={14} />斜体</button>
                              <button type="button" onClick={() => { insertMarkdown('- ', '', '列表项'); setPostToolbarMenuOpen(false); }} className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white"><List size={14} />列表</button>
                              <button type="button" onClick={() => { insertMarkdown('```\n', '\n```', '代码'); setPostToolbarMenuOpen(false); }} className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white"><Code2 size={14} />代码块</button>
                              <button type="button" onClick={() => { setEditorFocusMode(true); setPostToolbarMenuOpen(false); }} className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white"><Maximize2 size={14} />专注写作</button>
                              <button type="button" onClick={() => { setPreviewOpen(true); setPostToolbarMenuOpen(false); }} className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white"><Eye size={14} />文章预览</button>
                            </div>}
                          </div>
                          <button title="文章实时预览" aria-label="打开当前文章实时预览" onClick={() => setPreviewOpen(true)} className="hidden h-11 w-11 shrink-0 place-items-center rounded bg-indigo-400/[0.09] text-indigo-300 hover:bg-indigo-400/[0.15] md:grid"><Eye size={15} /></button>
                        </div>

                        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] pb-3 text-xs text-zinc-600"><span>{postTextCount.totalCharacters} 字符</span><span>{postTextCount.chineseCharacters} 个汉字</span><span>{postTextCount.latinWords} 个英文词</span><span>{postOutline.length} 个标题</span></div>

                        <div className={`${postEditorView === 'split' ? 'grid gap-3 lg:grid-cols-2' : 'block'} overflow-hidden rounded-md border border-white/[0.08] bg-[#090b11]`}>
                          {postEditorView !== 'preview' && (
                            <textarea
                              ref={markdownEditorRef}
                              value={post.content}
                              onChange={(event) => updatePost({ content: event.target.value, readTime: estimateReadTime(event.target.value) })}
                              aria-label="Markdown 正文"
                              placeholder="开始写作…"
                              className="min-h-[580px] w-full resize-none overflow-hidden bg-transparent p-5 font-mono text-sm leading-7 text-zinc-200 outline-none placeholder:text-zinc-700 [field-sizing:content] sm:p-6"
                            />
                          )}
                          {postEditorView !== 'write' && (
                            <div className={`${postEditorView === 'split' ? 'border-l border-white/[0.07]' : ''} min-h-[580px] bg-[#0c0f15] p-5 sm:p-7`}>
                              {post.coverImage && <img src={post.coverImage} alt="文章封面" className="mb-6 max-h-72 w-full rounded-md object-cover" />}
                              <MarkdownPreview content={post.content} />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {postSettingsOpen && <button type="button" tabIndex={-1} aria-label="关闭文章设置" onClick={() => setPostSettingsOpen(false)} className="fixed inset-0 z-[104] bg-black/70 min-[1600px]:hidden" />}
                    <aside ref={postSettingsPanelRef} role={postSettingsIsModal ? 'dialog' : undefined} aria-modal={postSettingsIsModal ? true : undefined} tabIndex={-1} className={`${postSettingsOpen ? 'fixed inset-y-0 right-0 z-[105] flex h-dvh w-[min(380px,100vw)] shadow-2xl shadow-black/70' : 'hidden'} min-h-0 flex-col overscroll-contain border-l border-white/[0.07] bg-[#0a0c11] outline-none min-[1600px]:static min-[1600px]:z-auto min-[1600px]:flex min-[1600px]:h-auto min-[1600px]:w-auto min-[1600px]:shadow-none`} aria-labelledby="post-settings-heading">
                      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
                        <div><h3 id="post-settings-heading" className="text-sm font-semibold">文章设置</h3><p className="mt-1 text-xs text-zinc-500">发布、内容与搜索展示</p></div>
                        <button ref={postSettingsCloseRef} type="button" aria-label="关闭文章设置" onClick={() => setPostSettingsOpen(false)} className="grid h-11 w-11 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.05] hover:text-white min-[1600px]:hidden"><X size={16} /></button>
                      </div>

                      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
                        <section className="space-y-4 border-b border-white/[0.07] pb-6">
                          <div><h4 className="text-xs font-semibold text-zinc-200">发布</h4><p className="mt-1 text-xs leading-5 text-zinc-600">控制公开状态和发布时间</p></div>
                          <div className="grid grid-cols-2 rounded-lg border border-white/[0.08] bg-black/20 p-1" role="group" aria-label="文章发布状态">
                            <button type="button" aria-pressed={post.status === 'draft'} onClick={() => { if (post.status !== 'draft') withdrawCurrentPost(); }} className={`h-10 rounded-md text-xs transition ${post.status === 'draft' ? 'bg-amber-400/[0.1] text-amber-200' : 'text-zinc-500 hover:text-zinc-200'}`}>草稿</button>
                            <button type="button" aria-pressed={post.status === 'published'} onClick={() => { if (post.status !== 'published' || !persistedPostIsPublished) void publishCurrentPost(); }} className={`h-10 rounded-md text-xs transition ${post.status === 'published' ? postIsScheduled ? 'bg-sky-400/[0.1] text-sky-200' : 'bg-emerald-400/[0.1] text-emerald-200' : 'text-zinc-500 hover:text-zinc-200'}`}>{postIsScheduled ? '定时' : '已发布'}</button>
                          </div>
                          <Field label="定时发布">
                            <span className="flex gap-2"><span className="relative min-w-0 flex-1"><CalendarClock size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" /><input type="datetime-local" className={`${inputClass} pl-9`} value={toDatetimeLocalValue(post.scheduledAt)} onChange={(event) => updatePost({ scheduledAt: fromDatetimeLocalValue(event.target.value) })} /></span>{post.scheduledAt && <button type="button" title="清除定时发布" aria-label="清除定时发布" onClick={() => updatePost({ scheduledAt: undefined })} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/[0.09] text-zinc-500 hover:bg-white/[0.04] hover:text-white"><X size={14} /></button>}</span>
                          </Field>
                          <div className={`border-l-2 px-3 py-2.5 text-xs ${postPublishIssues.length ? 'border-amber-400/40 bg-amber-400/[0.04] text-amber-100' : 'border-emerald-400/40 bg-emerald-400/[0.04] text-emerald-100'}`}>
                            <p className="font-medium">{postPublishIssues.length ? `发布检查：${postPublishIssues.length} 项待处理` : '发布检查已通过'}</p>
                            {postPublishChecks.blocking.length > 0 && <ul className="mt-2 space-y-1 text-rose-200/80">{postPublishChecks.blocking.map((issue) => <li key={issue}>必须：{issue}</li>)}</ul>}
                            {postScheduleIsInvalid && <p className="mt-2 text-rose-200/80">必须：重新选择或清除无效的定时发布时间</p>}
                            {postPublishChecks.warnings.length > 0 && <ul className="mt-2 space-y-1 text-amber-200/65">{postPublishChecks.warnings.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                          </div>
                        </section>

                        <section className="space-y-4 border-b border-white/[0.07] pb-6">
                          <div><h4 className="text-xs font-semibold text-zinc-200">内容信息</h4><p className="mt-1 text-xs leading-5 text-zinc-600">用于列表、归档和内容组织</p></div>
                          <Field label="摘要"><textarea className={`${inputClass} min-h-28`} value={post.excerpt} onChange={(event) => updatePost({ excerpt: event.target.value })} placeholder="用于文章列表和分享摘要" /><span className="block text-right text-xs text-zinc-500">{post.excerpt.length} 字</span></Field>
                          <Field label="分类"><input list="post-category-options" className={inputClass} value={post.category} onChange={(event) => updatePost({ category: event.target.value })} onBlur={(event) => updatePost({ category: event.target.value.trim() })} placeholder="选择或输入分类" /><datalist id="post-category-options">{postCategories.map((category) => <option key={category} value={category} />)}</datalist></Field>
                          <div className={labelClass}>
                            <span className="block">标签</span>
                            <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#090b11] p-2 focus-within:border-indigo-400/70 focus-within:ring-2 focus-within:ring-indigo-500/15">
                              {post.tags.map((tag) => <button key={tag} type="button" title={`移除 ${tag}`} aria-label={`移除标签 ${tag}`} onClick={() => removePostTag(tag)} className="flex h-8 items-center gap-1 rounded-md bg-white/[0.06] px-2 text-xs font-normal text-zinc-300 hover:bg-rose-400/[0.08] hover:text-rose-200">{tag}<X size={11} /></button>)}
                              <input value={postTagDraft} onChange={(event) => setPostTagDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commitPostTags(postTagDraft); } }} onBlur={() => commitPostTags(postTagDraft)} className="h-8 min-w-24 flex-1 bg-transparent px-1 text-sm font-normal text-zinc-100 outline-none placeholder:text-zinc-600" placeholder="输入后按回车" />
                            </div>
                            {postTagSuggestions.length > 0 && <div className="flex flex-wrap gap-1.5 pt-1">{postTagSuggestions.slice(0, 8).map((tag) => <button key={tag} type="button" onClick={() => commitPostTags(tag)} className="min-h-8 rounded-md border border-white/[0.07] px-2 text-xs font-normal text-zinc-500 hover:border-white/[0.12] hover:text-zinc-200">+ {tag}</button>)}</div>}
                          </div>
                          <Field label="文章日期"><input type="date" className={inputClass} value={post.date} onChange={(event) => updatePost({ date: event.target.value })} /></Field>
                          <div className="space-y-3 pt-1">
                            <div className="flex items-center justify-between"><h5 className="text-xs font-medium text-zinc-300">封面图片</h5>{post.coverImage && <button type="button" onClick={() => updatePost({ coverImage: undefined })} className="min-h-8 text-xs text-rose-300 hover:text-rose-200">清除</button>}</div>
                            {post.coverImage ? <img src={post.coverImage} alt="当前文章封面" className="aspect-[16/9] w-full rounded-md object-cover" /> : <div className="grid aspect-[16/9] place-items-center border border-dashed border-white/[0.09] text-xs text-zinc-600">尚未设置封面</div>}
                            <button type="button" disabled={saveBlocked} onClick={() => { if (saveBlockedRef.current) return; setPostSettingsOpen(false); setMediaPickerOpen(true); void loadMedia(); }} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-white/[0.09] text-xs text-zinc-300 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"><ImagePlus size={14} />从媒体库选择</button>
                            <Field label="封面地址"><input type="url" className={inputClass} value={post.coverImage || ''} onChange={(event) => updatePost({ coverImage: event.target.value || undefined })} placeholder="https://…" /></Field>
                          </div>
                        </section>

                        <section className="space-y-4 border-b border-white/[0.07] pb-6">
                          <div><h4 className="text-xs font-semibold text-zinc-200">SEO 与分享</h4><p className="mt-1 text-xs leading-5 text-zinc-600">优化搜索结果标题与摘要</p></div>
                          <Field label="文章 Slug"><span className="flex gap-2"><input className={inputClass} value={post.slug || ''} onChange={(event) => updatePost({ slug: event.target.value })} onBlur={(event) => updatePost({ slug: slugifyPostTitle(event.target.value) || undefined })} placeholder="article-slug" /><button type="button" title="根据标题生成 Slug" aria-label="根据标题生成 Slug" onClick={() => updatePost({ slug: slugifyPostTitle(post.title) || undefined })} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/[0.09] text-zinc-500 hover:bg-white/[0.04] hover:text-indigo-200"><Sparkles size={14} /></button></span></Field>
                          <Field label="SEO 标题"><input className={inputClass} value={post.seoTitle || ''} onChange={(event) => updatePost({ seoTitle: event.target.value || undefined })} placeholder={post.title || '搜索结果标题'} /><span className={`block text-right text-xs ${(post.seoTitle?.length || 0) > 60 ? 'text-amber-300' : 'text-zinc-500'}`}>{post.seoTitle?.length || 0} / 60</span></Field>
                          <Field label="SEO 描述"><textarea className={`${inputClass} min-h-24`} value={post.seoDescription || ''} onChange={(event) => updatePost({ seoDescription: event.target.value || undefined })} placeholder={post.excerpt || '搜索结果描述'} /><span className={`block text-right text-xs ${(post.seoDescription?.length || 0) > 160 ? 'text-amber-300' : 'text-zinc-500'}`}>{post.seoDescription?.length || 0} / 160</span></Field>
                          <div className="border border-white/[0.08] bg-[#0d1017] p-3"><p className="text-xs text-emerald-300/80">beta-demo.top · 博客</p><p className="mt-1.5 line-clamp-2 text-sm font-medium leading-5 text-sky-300">{post.seoTitle || post.title || '未命名文章'}</p><p className="mt-1 line-clamp-3 text-xs leading-5 text-zinc-500">{post.seoDescription || post.excerpt || '尚未填写搜索描述'}</p></div>
                        </section>

                        <details className="border-b border-white/[0.07] pb-6">
                          <summary className="cursor-pointer text-xs font-medium text-zinc-300">高级设置</summary>
                          <div className="mt-4 space-y-4">
                            <Field label="文章 ID"><input className={inputClass} value={post.id} onChange={(event) => updatePost({ id: event.target.value })} /></Field>
                            <div className="grid grid-cols-2 gap-2 text-center text-xs"><span className="bg-black/20 p-3 text-zinc-500"><strong className="mb-1 block text-sm text-zinc-200">{post.views}</strong>浏览量</span><span className="bg-black/20 p-3 text-zinc-500"><strong className="mb-1 block text-sm text-zinc-200">{post.likes}</strong>点赞</span></div>
                          </div>
                        </details>

                        <section className="space-y-3 pb-3"><div><h4 className="text-xs font-semibold text-rose-200">危险操作</h4><p className="mt-1 text-xs leading-5 text-zinc-600">删除后需保存才会影响公开站点</p></div><button type="button" onClick={() => { setPostSettingsOpen(false); setConfirmation({ title: `删除文章“${post.title}”？`, description: '文章会先从当前编辑内容中移除，保存全部更改后才会影响公开站点。', confirmLabel: '删除文章', onConfirm: () => { setContent((current) => ({ ...current, blogPosts: current.blogPosts.filter((_, index) => index !== selectedPost) })); setSelectedPostIds(new Set()); setSelectedPost(0); setPostEditorOpen(false); } }); }} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-rose-400/10 text-xs text-rose-300 hover:bg-rose-400/[0.06]"><Trash2 size={14} />删除文章</button></section>
                      </div>

                      <div className="sticky bottom-0 border-t border-white/[0.08] bg-[#0a0c11]/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur min-[1600px]:hidden">
                        <div className="flex gap-2">
                          {post.status === 'draft' && <button type="button" onClick={() => void saveCurrentPost(true)} disabled={saving || !isDirty || saveBlocked} className="min-h-11 flex-1 rounded-md border border-white/[0.09] px-3 text-xs text-zinc-300 hover:bg-white/[0.04] disabled:opacity-40">保存草稿</button>}
                          <button type="button" onClick={() => void (post.status === 'draft' ? publishCurrentPost(true) : handleArticlePrimaryAction(true))} disabled={saving || saveBlocked || (post.status !== 'draft' && !isDirty)} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-40"><Save size={14} />{saving ? '保存中…' : post.status === 'draft' ? postIsScheduled ? '安排发布' : '发布文章' : articlePrimaryLabel}</button>
                        </div>
                        <p className="mt-2 text-center text-xs text-zinc-600">保存文章时会一并同步本次其他待保存更改</p>
                      </div>
                    </aside>
                  </div>
                </div>
              ) : (
                <div className="hidden place-items-center px-6 text-center xl:grid"><div><FileText size={28} className="mx-auto text-zinc-700" /><p className="mt-3 text-sm text-zinc-400">还没有文章</p><button onClick={addPost} className="mt-4 rounded-md bg-indigo-500 px-4 py-2 text-xs font-medium text-white">新建草稿</button></div></div>
              )}
            </div>
          )}

          {activeSection === 'aboutPage' && (
            <div className="space-y-8">
              <div className="space-y-4">
                <h2 className="font-semibold">关于页面内容</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {aboutPageFields.map(([key, label]) => (
                    <div key={key}><Field label={label}>
                      {key === 'description' || key === 'contactDescription' ? <textarea className={`${inputClass} min-h-24`} value={content.aboutPage[key]} onChange={(event) => updateAboutPage((value) => ({ ...value, [key]: event.target.value }))} /> : <input className={inputClass} value={content.aboutPage[key]} onChange={(event) => updateAboutPage((value) => ({ ...value, [key]: event.target.value }))} />}
                    </Field></div>
                  ))}
                </div>
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">自我介绍段落</h3><button onClick={() => updateAboutPage((value) => ({ ...value, introduction: [...value.introduction, ''] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加段落</button></div>
                {content.aboutPage.introduction.length === 0 && <EmptyList>暂无自我介绍段落</EmptyList>}
                {content.aboutPage.introduction.map((paragraph, index) => (
                  <div key={index} className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-4"><textarea className={`${inputClass} min-h-24`} value={paragraph} onChange={(event) => updateAboutPage((value) => ({ ...value, introduction: value.introduction.map((entry, itemIndex) => itemIndex === index ? event.target.value : entry) }))} /><button title="删除段落" aria-label={`删除自我介绍段落 ${index + 1}`} onClick={() => updateAboutPage((value) => ({ ...value, introduction: value.introduction.filter((_, itemIndex) => itemIndex !== index) }))} className="self-start p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button></div>
                ))}
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">兴趣与日常</h3><button onClick={() => updateAboutPage((value) => ({ ...value, hobbies: [...value.hobbies, { id: `hobby-${Date.now()}`, title: '新兴趣', description: '', icon: 'coffee' }] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加兴趣</button></div>
                {content.aboutPage.hobbies.length === 0 && <EmptyList>暂无兴趣内容</EmptyList>}
                {content.aboutPage.hobbies.map((hobby, index) => (
                  <div key={`${hobby.id}-${index}`} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                    <Field label="兴趣 ID"><input className={inputClass} value={hobby.id} onChange={(event) => updateAboutPage((value) => ({ ...value, hobbies: value.hobbies.map((entry, itemIndex) => itemIndex === index ? { ...entry, id: event.target.value } : entry) }))} /></Field>
                    <Field label="标题"><input className={inputClass} value={hobby.title} onChange={(event) => updateAboutPage((value) => ({ ...value, hobbies: value.hobbies.map((entry, itemIndex) => itemIndex === index ? { ...entry, title: event.target.value } : entry) }))} /></Field>
                    <Field label="图标"><select className={inputClass} value={hobby.icon} onChange={(event) => updateAboutPage((value) => ({ ...value, hobbies: value.hobbies.map((entry, itemIndex) => itemIndex === index ? { ...entry, icon: event.target.value as SiteContent['aboutPage']['hobbies'][number]['icon'] } : entry) }))}><option value="coffee">Coffee</option><option value="code">Code</option><option value="game">Game</option><option value="screen">Screen</option></select></Field>
                    <Field label="描述"><input className={inputClass} value={hobby.description} onChange={(event) => updateAboutPage((value) => ({ ...value, hobbies: value.hobbies.map((entry, itemIndex) => itemIndex === index ? { ...entry, description: event.target.value } : entry) }))} /></Field>
                    <button onClick={() => updateAboutPage((value) => ({ ...value, hobbies: value.hobbies.filter((_, itemIndex) => itemIndex !== index) }))} className="flex items-center gap-1 text-xs text-rose-400 md:col-span-2 md:justify-self-end"><Trash2 size={14} />删除兴趣</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'agentPage' && (
            <div className="space-y-8">
              <div className="space-y-4">
                <h2 className="font-semibold">智能体页面内容</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {agentPageFields.map(([key, label]) => (
                    <div key={key}><Field label={label}>
                      {key === 'description' || key === 'welcomeMessage' ? <textarea className={`${inputClass} min-h-28`} value={content.agentPage[key]} onChange={(event) => updateAgentPage((value) => ({ ...value, [key]: event.target.value }))} /> : <input className={inputClass} value={content.agentPage[key]} onChange={(event) => updateAgentPage((value) => ({ ...value, [key]: event.target.value }))} />}
                    </Field></div>
                  ))}
                </div>
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">快速提问</h3><button onClick={() => updateAgentPage((value) => ({ ...value, samplePrompts: [...value.samplePrompts, { label: '新问题', text: '' }] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加问题</button></div>
                {content.agentPage.samplePrompts.length === 0 && <EmptyList>暂无快速提问</EmptyList>}
                {content.agentPage.samplePrompts.map((prompt, index) => (
                  <div key={index} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-[180px_1fr_auto]">
                    <Field label="短标签"><input className={inputClass} value={prompt.label} onChange={(event) => updateAgentPage((value) => ({ ...value, samplePrompts: value.samplePrompts.map((entry, itemIndex) => itemIndex === index ? { ...entry, label: event.target.value } : entry) }))} /></Field>
                    <Field label="完整问题"><input className={inputClass} value={prompt.text} onChange={(event) => updateAgentPage((value) => ({ ...value, samplePrompts: value.samplePrompts.map((entry, itemIndex) => itemIndex === index ? { ...entry, text: event.target.value } : entry) }))} /></Field>
                    <button title="删除问题" aria-label={`删除快速提问 ${prompt.label || index + 1}`} onClick={() => updateAgentPage((value) => ({ ...value, samplePrompts: value.samplePrompts.filter((_, itemIndex) => itemIndex !== index) }))} className="self-end p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">点击趣味语录</h3><button onClick={() => updateAgentPage((value) => ({ ...value, funQuotes: [...value.funQuotes, '新的趣味语录'] }))} className="flex items-center gap-1 text-xs text-indigo-300"><Plus size={14} />添加语录</button></div>
                {content.agentPage.funQuotes.length === 0 && <EmptyList>暂无趣味语录</EmptyList>}
                {content.agentPage.funQuotes.map((quote, index) => (
                  <div key={index} className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-4"><input className={inputClass} value={quote} onChange={(event) => updateAgentPage((value) => ({ ...value, funQuotes: value.funQuotes.map((entry, itemIndex) => itemIndex === index ? event.target.value : entry) }))} /><button title="删除语录" aria-label={`删除趣味语录 ${index + 1}`} onClick={() => updateAgentPage((value) => ({ ...value, funQuotes: value.funQuotes.filter((_, itemIndex) => itemIndex !== index) }))} className="p-2 text-zinc-500 hover:text-rose-400"><Trash2 size={16} /></button></div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'musicPlayer' && (
            <div className="space-y-8">
              <div className="space-y-4">
                <h2 className="font-semibold">音乐播放器内容</h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <Field label="播放器标题"><input className={inputClass} value={content.musicPlayer.title} onChange={(event) => updateMusicPlayer((value) => ({ ...value, title: event.target.value }))} /></Field>
                  <Field label="最小化提示"><input className={inputClass} value={content.musicPlayer.minimizedLabel} onChange={(event) => updateMusicPlayer((value) => ({ ...value, minimizedLabel: event.target.value }))} /></Field>
                  <Field label="待机提示"><input className={inputClass} value={content.musicPlayer.standbyLabel} onChange={(event) => updateMusicPlayer((value) => ({ ...value, standbyLabel: event.target.value }))} /></Field>
                  <Field label="播放中前缀"><input className={inputClass} value={content.musicPlayer.playingPrefix} onChange={(event) => updateMusicPlayer((value) => ({ ...value, playingPrefix: event.target.value }))} /></Field>
                </div>
              </div>

              <div className="space-y-4 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">环境音轨</h3><p className="mt-1 text-xs text-zinc-500">频率单位为 Hz</p></div><button onClick={() => updateMusicPlayer((value) => ({ ...value, tracks: [...value.tracks, { id: `track-${Date.now()}`, name: '新音轨', description: '', type: 'synth', frequency: 220 }] }))} className="flex min-h-11 items-center gap-1 px-2 text-xs text-indigo-300"><Plus size={14} />添加音轨</button></div>
                {content.musicPlayer.tracks.length === 0 && <EmptyList>暂无环境音轨</EmptyList>}
                {content.musicPlayer.tracks.map((track, index) => (
                  <div key={`${track.id}-${index}`} className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-2 xl:grid-cols-4">
                    <Field label="音轨 ID"><input className={inputClass} value={track.id} onChange={(event) => updateMusicPlayer((value) => ({ ...value, tracks: value.tracks.map((entry, itemIndex) => itemIndex === index ? { ...entry, id: event.target.value } : entry) }))} /></Field>
                    <Field label="名称"><input className={inputClass} value={track.name} onChange={(event) => updateMusicPlayer((value) => ({ ...value, tracks: value.tracks.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry) }))} /></Field>
                    <Field label="类型"><select className={inputClass} value={track.type} onChange={(event) => updateMusicPlayer((value) => ({ ...value, tracks: value.tracks.map((entry, itemIndex) => itemIndex === index ? { ...entry, type: event.target.value as SiteContent['musicPlayer']['tracks'][number]['type'] } : entry) }))}><option value="synth">Synth</option><option value="noise">Noise</option></select></Field>
                    <Field label="基础频率"><input type="number" min="20" max="20000" step="1" className={inputClass} value={track.frequency} onChange={(event) => updateMusicPlayer((value) => ({ ...value, tracks: value.tracks.map((entry, itemIndex) => itemIndex === index ? { ...entry, frequency: Number(event.target.value) || 0 } : entry) }))} /></Field>
                    <div className="md:col-span-2 xl:col-span-3"><Field label="音轨描述"><textarea className={`${inputClass} min-h-20`} value={track.description} onChange={(event) => updateMusicPlayer((value) => ({ ...value, tracks: value.tracks.map((entry, itemIndex) => itemIndex === index ? { ...entry, description: event.target.value } : entry) }))} /></Field></div>
                    <button onClick={() => updateMusicPlayer((value) => ({ ...value, tracks: value.tracks.filter((_, itemIndex) => itemIndex !== index) }))} className="flex items-center gap-1 self-end text-xs text-rose-400 xl:justify-self-end"><Trash2 size={14} />删除音轨</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
    </div>
  );
}
