import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Sparkles, ArrowRight, Play, ArrowUpRight, Code, MessageSquare, BookOpen, Layers } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSiteContent } from '../content';

const HIGHLIGHT_ICON_MAP = {
  code: { Icon: Code, className: 'text-indigo-400' },
  layers: { Icon: Layers, className: 'text-purple-400' },
  sparkles: { Icon: Sparkles, className: 'text-pink-400' },
} as const;

export default function LandingHome() {
  const { personalInfo, homePage } = useSiteContent();
  const [greeting, setGreeting] = useState(homePage.greetings[0] || '');

  useEffect(() => {
    const greetings = homePage.greetings;
    setGreeting(greetings[0] || '');
    if (greetings.length <= 1) return;

    let idx = 0;
    const interval = setInterval(() => {
      idx = (idx + 1) % greetings.length;
      setGreeting(greetings[idx]);
    }, 4000);
    return () => clearInterval(interval);
  }, [homePage.greetings]);

  return (
    <section id="landing-home" className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10 flex flex-col justify-center min-h-[calc(100vh-160px)]">
      {/* Decorative Top Line */}
      <div className="w-12 h-[1px] bg-indigo-500/55 mb-8" />

      {/* Main Content Area */}
      <div className="space-y-8 max-w-4xl">
        {/* Animated Badge */}
        <div className="inline-flex items-center space-x-2.5 px-3.5 py-1 bg-white/[0.03] border border-white/[0.06] rounded-full text-[10px] font-mono text-zinc-400 uppercase tracking-widest select-none">
          <Sparkles size={11} className="text-indigo-400 animate-pulse" />
          <span className="text-zinc-500">{personalInfo.name}</span>
          <span className="w-1 h-1 bg-zinc-700 rounded-full" />
          <span className="text-indigo-300 font-medium">{greeting}</span>
        </div>

        {/* Hero Title */}
        <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold tracking-tight text-white leading-[1.08] font-sans select-none">
          {homePage.heroPrefix}<span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-500 bg-clip-text text-transparent">{homePage.heroHighlight}</span>
          <br />
          {homePage.heroSuffix}
        </h1>

        {/* Subtitle / Bio */}
        <p className="text-zinc-400 text-sm sm:text-base max-w-2xl leading-relaxed font-sans font-medium">
          {homePage.introduction}
        </p>

        {/* High-tech Highlight Cards Row (Non-interactive display) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 max-w-3xl">
          {homePage.highlights.map((highlight) => {
            const iconConfig = HIGHLIGHT_ICON_MAP[highlight.icon] || HIGHLIGHT_ICON_MAP.sparkles;
            const HighlightIcon = iconConfig.Icon;
            return (
              <div key={highlight.id} className="p-4 rounded-xl bg-white/[0.01] border border-white/[0.03] space-y-2">
                <div className="flex items-center space-x-2 text-zinc-500">
                  <HighlightIcon size={13} className={iconConfig.className} />
                  <span className="text-[10px] font-mono uppercase tracking-wider">{highlight.title}</span>
                </div>
                <p className="text-xs text-zinc-400 font-sans">{highlight.description}</p>
              </div>
            );
          })}
        </div>

        {/* Actions CTAs */}
        <div className="flex flex-wrap gap-4 pt-6">
          <Link
            to="/portfolio"
            className="group px-6 py-3 bg-white text-black hover:bg-zinc-200 text-xs font-medium rounded-xl flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-white/5 active:scale-95"
          >
            {homePage.portfolioButton}
            <ArrowRight size={13} className="group-hover:translate-x-1 transition-transform" />
          </Link>

          <Link
            to="/agent"
            className="group px-6 py-3 bg-zinc-900 hover:bg-zinc-850 border border-white/[0.05] hover:border-white/[0.1] text-xs font-medium text-white rounded-xl flex items-center gap-2 transition-all cursor-pointer active:scale-95"
          >
            <Play size={11} className="text-indigo-400 group-hover:scale-125 transition-transform" />
            {homePage.agentButton}
          </Link>

          <Link
            to="/blog"
            className="px-6 py-3 bg-transparent hover:bg-white/[0.02] text-xs font-medium text-zinc-400 hover:text-white transition-all cursor-pointer"
          >
            {homePage.blogButton}
          </Link>
        </div>
      </div>
    </section>
  );
}
