import { motion } from 'motion/react';
import { Github, Twitter, Mail, Code, BookOpen, Home, User, Bot } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';
import { useSiteContent } from '../content';
import { pagePath } from '../routing';
import type { PageId } from '../types';

const NAV_ICON_MAP = {
  home: Home,
  showcase: Code,
  blog: BookOpen,
  agent: Bot,
  about: User,
} as const;

interface HeaderProps {
  activeTab: PageId | null;
}

export default function Header({ activeTab }: HeaderProps) {
  const { personalInfo, siteSettings } = useSiteContent();
  return (
    <header
      id="app-header"
      className="sticky top-0 z-50 w-full border-b border-white/[0.06] bg-black/40 backdrop-blur-md px-4 sm:px-6 py-3 sm:py-4"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Left: Identity */}
        <Link
          to="/"
          aria-label={`返回首页：${personalInfo.name}`}
          className="flex items-center space-x-3 cursor-pointer select-none shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <span className="relative flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 p-[1px]">
            <span className="w-full h-full bg-zinc-950 rounded-[7px] flex items-center justify-center font-mono font-bold text-xs sm:text-sm text-white">
              {siteSettings.brandInitials}
            </span>
            <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 flex h-2 sm:h-2.5 w-2 sm:w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 sm:h-2.5 w-2 sm:w-2.5 bg-emerald-500"></span>
            </span>
          </span>
          <span className="hidden md:block">
            <span className="font-sans font-medium tracking-tight text-white block text-sm">
              {personalInfo.name}
            </span>
            <span className="font-mono text-[10px] text-zinc-500 tracking-wider uppercase">
              {personalInfo.title.split('&')[0]}
            </span>
          </span>
        </Link>

        {/* Center: Interactive Tabs */}
        <nav aria-label="主导航" className="flex space-x-0.5 sm:space-x-1 bg-zinc-900/60 p-1 rounded-full border border-white/[0.05] overflow-x-auto scrollbar-none max-w-[65%] sm:max-w-none">
          {siteSettings.navigation.map((item) => {
            const NavIcon = NAV_ICON_MAP[item.id] || Home;
            return (
              <NavLink
                key={item.id}
                id={`nav-${item.id}`}
                to={pagePath(item.id)}
                end={item.id === 'home'}
                aria-current={activeTab === item.id ? 'page' : undefined}
                aria-label={item.label}
                className={`relative px-2.5 sm:px-4 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-medium transition-colors duration-200 flex items-center gap-1 sm:gap-1.5 shrink-0 ${
                  activeTab === item.id ? 'text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {activeTab === item.id && (
                  <motion.span
                    aria-hidden="true"
                    layoutId="active-tab-indicator"
                    className="absolute inset-0 bg-white/[0.08] rounded-full border border-white/[0.04]"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                )}
                <NavIcon aria-hidden="true" size={13} className="relative z-10 shrink-0" />
                <span className="relative z-10 hidden sm:inline">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Right: Social & Contacts */}
        <div className="flex items-center space-x-1 sm:space-x-3 shrink-0">
          <a
            id="social-github"
            href={personalInfo.github}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="访问 GitHub 主页"
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.04] transition-all"
            title="GitHub Portfolio"
          >
            <Github aria-hidden="true" size={16} />
          </a>
          {personalInfo.twitter && (
            <a
              id="social-twitter"
              href={personalInfo.twitter}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="访问 Twitter 或 X 主页"
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.04] transition-all"
              title="Twitter / X"
            >
              <Twitter aria-hidden="true" size={16} />
            </a>
          )}
          {personalInfo.email && (
            <a
              id="social-email"
              href={`mailto:${personalInfo.email}`}
              aria-label="发送电子邮件"
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.04] transition-all"
              title="Send Email"
            >
              <Mail aria-hidden="true" size={16} />
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
