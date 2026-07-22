import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Link } from 'react-router-dom';
import {
  Search,
  Calendar,
  Clock,
  Heart,
  Eye,
  ArrowLeft,
  Share2,
  Bookmark,
  Check
} from 'lucide-react';
import { useSiteContent, useSiteContentStatus } from '../content';
import { blogPostPath } from '../routing';
import MarkdownRenderer from './MarkdownRenderer';
import RouteNotFound from './RouteNotFound';
import RouteContentPending from './RouteContentPending';

export default function BlogSection({ requestedPostKey }: { requestedPostKey?: string }) {
  const { blogPosts, blogPage } = useSiteContent();
  const contentStatus = useSiteContentStatus();
  const selectedPost = requestedPostKey
    ? blogPosts.find((post) => post.id === requestedPostKey || post.slug === requestedPostKey) ?? null
    : null;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('__all__');
  const [likedPosts, setLikedPosts] = useState<Record<string, number>>({});
  const [isBookmarked, setIsBookmarked] = useState<Record<string, boolean>>({});
  const [copyFeedback, setCopyFeedback] = useState<'success' | 'error' | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const copyFeedbackTimerRef = useRef<number | null>(null);

  const categories = ['__all__', ...Array.from(new Set(blogPosts.map((post) => post.category)))];

  // Filter posts based on category and search query
  const filteredPosts = blogPosts.filter((post) => {
    const matchesCategory = selectedCategory === '__all__' || post.category === selectedCategory;
    const matchesSearch =
      post.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.excerpt.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  // Reading progress scroll tracker
  useEffect(() => {
    if (!selectedPost) {
      setScrollProgress(0);
      return;
    }

    let animationFrame: number | null = null;
    const updateProgress = () => {
      animationFrame = null;
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = totalHeight > 0 ? (window.scrollY / totalHeight) * 100 : 0;
      setScrollProgress(Math.min(100, Math.max(0, progress)));
    };
    const handleScroll = () => {
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(updateProgress);
    };

    updateProgress();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [selectedPost]);

  // Handle Like trigger
  const handleLike = (postId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLikedPosts((prev) => ({
      ...prev,
      [postId]: (prev[postId] || 0) + 1
    }));
  };

  // Bookmark trigger
  const toggleBookmark = (postId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setIsBookmarked((prev) => ({
      ...prev,
      [postId]: !prev[postId]
    }));
  };

  const copyArticleLink = async () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(window.location.href);
      setCopyFeedback('success');
    } catch {
      setCopyFeedback('error');
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimerRef.current = null;
    }, 2500);
  };

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);

  if (requestedPostKey && !selectedPost) {
    return contentStatus === 'ready'
      ? <RouteNotFound resource="文章" />
      : <RouteContentPending resource="文章" status={contentStatus} />;
  }

  return (
    <div id="blog-section" className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10 relative z-10">
      <AnimatePresence mode="wait">
        {!selectedPost ? (
          /* ==========================================
              MAIN VIEW: Articles Browser
             ========================================== */
          <motion.div
            key="list"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.35 }}
            className="space-y-8"
          >
            {/* Header intro of blog */}
            <div className="space-y-2 text-center max-w-xl mx-auto mb-10">
              <span className="text-indigo-400 font-mono text-xs uppercase tracking-widest block">
                {blogPage.eyebrow}
              </span>
              <h1 className="text-3xl font-bold font-sans text-white">{blogPage.title}</h1>
              <p className="text-zinc-400 text-xs leading-relaxed">
                {blogPage.description}
              </p>
            </div>

            {/* Controls Bar */}
            <div className="flex flex-col sm:flex-row gap-4 items-center justify-between pb-4 border-b border-white/[0.05]">
              {/* Search input field */}
              <div className="relative w-full sm:max-w-xs">
                <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <label htmlFor="blog-search" className="sr-only">搜索博客文章</label>
                <input
                  id="blog-search"
                  type="text"
                  placeholder={blogPage.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-zinc-950/50 hover:bg-zinc-950 border border-white/[0.05] rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-indigo-500/50 transition-all"
                />
              </div>

              {/* Category tags selector */}
              <div className="flex flex-wrap gap-1.5 self-start sm:self-center">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    aria-pressed={selectedCategory === cat}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-mono capitalize transition-all cursor-pointer ${
                      selectedCategory === cat
                        ? 'bg-indigo-600 text-white'
                        : 'text-zinc-400 hover:text-white hover:bg-white/[0.03]'
                    }`}
                  >
                    {cat === '__all__' ? blogPage.allCategoryLabel : cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Blogs List */}
            <div className="grid grid-cols-1 gap-6">
              {filteredPosts.length > 0 ? (
                filteredPosts.map((post) => (
                  <article
                    key={post.id}
                    className="group bg-zinc-950/30 hover:bg-zinc-950/60 border border-white/[0.04] hover:border-white/[0.08] p-6 rounded-2xl transition-all duration-300"
                  >
                    <div className="flex flex-col gap-4">
                      {/* Meta data row */}
                      <div className="flex flex-wrap items-center gap-4 text-[10px] font-mono text-zinc-500">
                        <span className="text-indigo-400 font-semibold uppercase">{post.category}</span>
                        <span className="flex items-center gap-1">
                          <Calendar size={11} /> {post.date}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock size={11} /> {post.readTime}
                        </span>
                      </div>

                      {/* Title */}
                      <h3 className="text-lg font-bold text-white group-hover:text-indigo-300 transition-colors font-sans">
                        <Link
                          to={blogPostPath(post)}
                          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                          className="rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                        >
                          {post.title}
                        </Link>
                      </h3>

                      {/* Excerpt */}
                      <p className="text-zinc-400 text-xs leading-relaxed line-clamp-2">
                        {post.excerpt}
                      </p>

                      {/* Bottom controls row */}
                      <div className="flex items-center justify-between pt-4 border-t border-white/[0.03] text-[10px] font-mono text-zinc-500">
                        {/* Tags */}
                        <div className="flex flex-wrap gap-1">
                          {post.tags.map((tag) => (
                            <span
                              key={tag}
                              className="px-2 py-0.5 rounded bg-zinc-900 border border-white/[0.03] text-[9px] text-zinc-400"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>

                        {/* Interactive counters */}
                        <div className="flex items-center space-x-4">
                          <button
                            onClick={(e) => handleLike(post.id, e)}
                            aria-label={`喜欢文章：${post.title}`}
                            className="flex items-center gap-1 hover:text-rose-400 transition-colors cursor-pointer group/btn"
                          >
                            <Heart
                              size={12}
                              className={`transition-transform duration-200 group-hover/btn:scale-125 ${
                                likedPosts[post.id] ? 'fill-rose-500 text-rose-500' : ''
                              }`}
                            />
                            <span>{post.likes + (likedPosts[post.id] || 0)}</span>
                          </button>

                          <span className="flex items-center gap-1">
                            <Eye size={12} />
                            <span>{post.views}</span>
                          </span>

                          <button
                            onClick={(e) => toggleBookmark(post.id, e)}
                            aria-label={`${isBookmarked[post.id] ? '取消收藏' : '收藏'}文章：${post.title}`}
                            aria-pressed={Boolean(isBookmarked[post.id])}
                            className="text-zinc-500 hover:text-white transition-colors cursor-pointer"
                          >
                            <Bookmark
                              size={12}
                              className={isBookmarked[post.id] ? 'fill-white text-white' : ''}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="text-center py-16 bg-zinc-950/20 border border-white/[0.03] rounded-2xl">
                  <p className="text-zinc-500 text-xs font-mono">{blogPage.noResultsText}</p>
                </div>
              )}
            </div>
          </motion.div>
        ) : (
          /* ==========================================
              IMMERSIVE ACTIVE READING VIEW
             ========================================== */
          <motion.div
            key="reading"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3 }}
            className="space-y-8"
          >
            {/* Horizontal Reading Progress Indicator */}
            <div className="fixed top-0 left-0 h-[2px] bg-indigo-500 z-50 transition-all duration-75" style={{ width: `${scrollProgress}%` }} />

            {/* Back button header controls */}
            <div className="flex items-center justify-between">
              <Link
                id="back-to-blogs"
                to="/blog"
                className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors text-xs font-mono cursor-pointer bg-zinc-900/60 border border-white/[0.05] px-3 py-1.5 rounded-lg"
              >
                <ArrowLeft size={13} /> {blogPage.backLabel}
              </Link>

              <div className="flex items-center space-x-2">
                <button
                  onClick={(e) => toggleBookmark(selectedPost.id, e)}
                  aria-label={isBookmarked[selectedPost.id] ? '取消收藏文章' : '收藏文章'}
                  aria-pressed={Boolean(isBookmarked[selectedPost.id])}
                  className="p-2 bg-zinc-900/60 border border-white/[0.05] hover:border-white/[0.1] rounded-lg text-zinc-400 hover:text-white transition-all cursor-pointer"
                  title="Bookmark"
                >
                  <Bookmark size={13} className={isBookmarked[selectedPost.id] ? 'fill-white text-white' : ''} />
                </button>
                <div className="relative">
                  <button
                    onClick={() => void copyArticleLink()}
                    className="p-2 bg-zinc-900/60 border border-white/[0.05] hover:border-white/[0.1] rounded-lg text-zinc-400 hover:text-white transition-all cursor-pointer flex items-center justify-center"
                    aria-label="复制文章链接"
                    title="Share"
                  >
                    {copyFeedback === 'success' ? <Check size={13} className="text-emerald-400 animate-scale-up" /> : <Share2 size={13} />}
                  </button>
                  <AnimatePresence>
                    {copyFeedback && (
                      <motion.span
                        role="status"
                        aria-live="polite"
                        initial={{ opacity: 0, y: 5, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className={`absolute bottom-full right-0 mb-2 whitespace-nowrap rounded border bg-zinc-900 px-2 py-1 font-mono text-xs shadow-xl ${copyFeedback === 'success' ? 'border-white/[0.08] text-zinc-300' : 'border-rose-400/20 text-rose-200'}`}
                      >
                        {copyFeedback === 'success' ? blogPage.linkCopiedLabel : '无法复制，请手动复制地址'}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

            {/* Reading Content Core */}
            <article className="bg-zinc-950/20 border border-white/[0.03] p-5 sm:p-8 rounded-2xl sm:rounded-3xl backdrop-blur-sm shadow-xl space-y-6">
              {/* Category, Read Time & Stats */}
              <div className="flex flex-wrap items-center gap-4 text-[10px] font-mono text-zinc-500 border-b border-white/[0.05] pb-4">
                <span className="text-indigo-400 font-semibold uppercase">{selectedPost.category}</span>
                <span className="w-1 h-1 bg-zinc-700 rounded-full" />
                <span className="flex items-center gap-1">
                  <Calendar size={11} /> {selectedPost.date}
                </span>
                <span className="w-1 h-1 bg-zinc-700 rounded-full" />
                <span className="flex items-center gap-1">
                  <Clock size={11} /> {selectedPost.readTime}
                </span>
                <span className="w-1 h-1 bg-zinc-700 rounded-full" />
                <span className="flex items-center gap-1">
                  <Eye size={11} /> {selectedPost.views} {blogPage.readsLabel}
                </span>
              </div>

              {/* Title */}
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-sans leading-snug">
                {selectedPost.title}
              </h1>

              {selectedPost.coverImage && (
                <img
                  src={selectedPost.coverImage}
                  alt={selectedPost.title}
                  decoding="async"
                  className="max-h-[460px] w-full rounded-2xl object-cover"
                />
              )}

              {/* Main Body */}
              <div className="prose prose-invert max-w-none prose-xs text-justify">
                <MarkdownRenderer content={selectedPost.content} />
              </div>

              {/* Article Footer Controls */}
              <div className="pt-8 border-t border-white/[0.05] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex flex-wrap gap-1.5">
                  {selectedPost.tags.map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 rounded bg-zinc-900 border border-white/[0.03] text-[9px] font-mono text-zinc-400"
                    >
                      #{t}
                    </span>
                  ))}
                </div>

                {/* Like Button */}
                <button
                  onClick={(e) => handleLike(selectedPost.id, e)}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-850 border border-white/[0.05] hover:border-indigo-500/30 text-xs font-mono text-zinc-300 hover:text-white transition-all cursor-pointer"
                >
                  <Heart
                    size={13}
                    className={`transition-transform duration-200 active:scale-125 ${
                      likedPosts[selectedPost.id] ? 'fill-rose-500 text-rose-500 scale-110' : 'text-zinc-400'
                    }`}
                  />
                  <span>
                    {blogPage.likeLabel} ({selectedPost.likes + (likedPosts[selectedPost.id] || 0)})
                  </span>
                </button>
              </div>
            </article>

            {/* Simple Reading Suggestion cards */}
            <div className="space-y-4 pt-4">
              <h4 className="text-xs font-mono uppercase tracking-widest text-zinc-400">{blogPage.relatedTitle}</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {blogPosts.filter((p) => p.id !== selectedPost.id)
                  .slice(0, 2)
                  .map((post) => (
                    <Link
                      key={post.id}
                      to={blogPostPath(post)}
                      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                      className="p-4 bg-zinc-950/40 hover:bg-zinc-950/70 border border-white/[0.03] hover:border-white/[0.06] rounded-xl cursor-pointer transition-all"
                    >
                      <span className="text-[9px] font-mono text-indigo-400 uppercase">{post.category}</span>
                      <h5 className="text-white text-xs font-semibold font-sans mt-1 line-clamp-1 group-hover:text-indigo-300">
                        {post.title}
                      </h5>
                    </Link>
                  ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
