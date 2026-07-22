import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import EffectsBackground from './components/EffectsBackground';
import Header from './components/Header';
import RouteAccessibility from './components/RouteAccessibility';
import RouteNotFound from './components/RouteNotFound';
import { useSiteContent, useSiteContentStatus } from './content';
import {
  applyPublicHead,
  buildPublicHead,
  publicRouteAnnouncement,
  resolvePublicRoute,
} from './publicHead';
import {
  blogPostPath,
  legacyPublicPath,
  pageIdFromPathname,
} from './routing';

const LandingHome = lazy(() => import('./components/LandingHome'));
const HomeShowcase = lazy(() => import('./components/HomeShowcase'));
const BlogSection = lazy(() => import('./components/BlogSection'));
const AboutSection = lazy(() => import('./components/AboutSection'));
const AgentSection = lazy(() => import('./components/AgentSection'));
const MusicPlayer = lazy(() => import('./components/MusicPlayer'));

function AnimatedPage({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

function LegacyHomeRoute() {
  const { blogPosts } = useSiteContent();
  const { search } = useLocation();
  const legacyTarget = legacyPublicPath(search, blogPosts);
  return legacyTarget ? <Navigate to={legacyTarget} replace /> : <LandingHome />;
}

function PortfolioRoute() {
  const { projectId } = useParams();
  return <HomeShowcase selectedProjectKey={projectId} />;
}

function BlogRoute() {
  const { postKey } = useParams();
  const { blogPosts } = useSiteContent();
  const navigate = useNavigate();
  const selectedPost = postKey
    ? blogPosts.find((post) => post.id === postKey || post.slug === postKey)
    : undefined;

  useEffect(() => {
    if (!postKey || !selectedPost) return;
    const canonicalPath = blogPostPath(selectedPost);
    const canonicalKey = selectedPost.slug?.trim() || selectedPost.id;
    if (postKey !== canonicalKey) navigate(canonicalPath, { replace: true });
  }, [navigate, postKey, selectedPost]);

  return <BlogSection requestedPostKey={postKey} />;
}

export default function App({ renderYear = new Date().getFullYear() }: { renderYear?: number }) {
  const content = useSiteContent();
  const { personalInfo, siteSettings } = content;
  const contentStatus = useSiteContentStatus();
  const location = useLocation();
  const activeTab = pageIdFromPathname(location.pathname);
  const requestUrl = `${location.pathname}${location.search}`;
  const resolvedRoute = resolvePublicRoute(
    requestUrl,
    content,
    contentStatus,
    'https://portfolio.invalid',
  );
  const routeHeading = publicRouteAnnouncement(resolvedRoute, content, contentStatus);
  const footerCopyright = siteSettings.footerCopyright
    .replace(/\{year\}/g, String(renderYear))
    .replace(/\{name\}/g, personalInfo.name);

  useEffect(() => {
    const route = resolvePublicRoute(requestUrl, content, contentStatus, window.location.origin);
    applyPublicHead(document, buildPublicHead(route, content, window.location.origin));
  }, [content, contentStatus, requestUrl]);

  return (
    <MotionConfig reducedMotion="user">
      <div
        id="app-root"
        className="min-h-screen bg-[#050507] text-zinc-100 flex flex-col font-sans relative overflow-x-hidden selection:bg-indigo-500/30 selection:text-white"
      >
        <a
          href="#main-content"
          className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          跳转到主要内容
        </a>

        <RouteAccessibility
          routeKey={`${location.pathname}${location.search}${location.hash}`}
          headingText={routeHeading}
          hash={location.hash}
        />

        <EffectsBackground />
        <Header activeTab={activeTab} />

        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 flex-grow focus:outline-none"
        >
          <Suspense fallback={<div className="min-h-[calc(100svh-5rem)]" aria-hidden="true" />}>
            <AnimatePresence mode="wait">
              <Routes location={location} key={activeTab ?? location.pathname}>
                <Route path="/" element={<AnimatedPage><LegacyHomeRoute /></AnimatedPage>} />
                <Route path="/portfolio/:projectId?" element={<AnimatedPage><PortfolioRoute /></AnimatedPage>} />
                <Route path="/blog/:postKey?" element={<AnimatedPage><BlogRoute /></AnimatedPage>} />
                <Route path="/agent" element={<AnimatedPage><AgentSection /></AnimatedPage>} />
                <Route path="/about" element={<AnimatedPage><AboutSection /></AnimatedPage>} />
                <Route path="*" element={<AnimatedPage><RouteNotFound /></AnimatedPage>} />
              </Routes>
            </AnimatePresence>
          </Suspense>
        </main>

        <footer className="w-full py-8 border-t border-white/[0.04] bg-black/20 text-center relative z-10">
          <div className="max-w-7xl mx-auto px-6 space-y-4 text-xs font-mono text-zinc-400">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <p>{footerCopyright}</p>
              <div className="flex space-x-4">
                {siteSettings.footerBadges.map((badge) => (
                  <span key={badge}>{badge}</span>
                ))}
              </div>
            </div>
            <a
              href={siteSettings.icpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block hover:text-zinc-300 transition-colors"
            >
              {siteSettings.icpNumber}
            </a>
          </div>
        </footer>

        <Suspense fallback={null}>
          <MusicPlayer />
        </Suspense>
      </div>
    </MotionConfig>
  );
}
