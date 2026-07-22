import React, { useEffect, useId, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Terminal as TerminalIcon,
  Briefcase,
  Layers,
  MapPin,
  ExternalLink,
  Github,
  Award,
  Sparkles,
  Command,
  ChevronRight,
  Maximize2,
  X
} from 'lucide-react';
import { useSiteContent, useSiteContentStatus } from '../content';
import { projectPath } from '../routing';
import { useModalA11y } from '../admin/useModalA11y';
import RouteNotFound from './RouteNotFound';
import RouteContentPending from './RouteContentPending';

export default function HomeShowcase({ selectedProjectKey }: { selectedProjectKey?: string }) {
  const { personalInfo, projects, techStackGroups, showcasePage } = useSiteContent();
  const contentStatus = useSiteContentStatus();
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState<string>(showcasePage.allFilterLabel);
  const selectedProject = selectedProjectKey
    ? projects.find((project) => project.id === selectedProjectKey) ?? null
    : null;

  // Terminal state
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<Array<{ type: 'cmd' | 'output'; text: string | string[] }>>([
    { type: 'output', text: showcasePage.terminalWelcome },
    { type: 'output', text: showcasePage.terminalHint }
  ]);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const projectDialogRef = useRef<HTMLDivElement>(null);
  const projectCloseRef = useRef<HTMLButtonElement>(null);
  const projectTitleId = useId();
  const terminalCopyRef = useRef({
    welcome: showcasePage.terminalWelcome,
    hint: showcasePage.terminalHint,
  });
  const allFilterLabelRef = useRef(showcasePage.allFilterLabel);

  const closeProject = () => navigate('/portfolio', { replace: true });

  useModalA11y({
    active: Boolean(selectedProject),
    containerRef: projectDialogRef,
    initialFocusRef: projectCloseRef,
    onClose: closeProject,
  });

  useEffect(() => {
    const previousCopy = terminalCopyRef.current;
    setTerminalHistory((current) => {
      const stillShowingInitialCopy = current.length === 2
        && current[0]?.type === 'output'
        && current[0].text === previousCopy.welcome
        && current[1]?.type === 'output'
        && current[1].text === previousCopy.hint;

      return stillShowingInitialCopy
        ? [
            { type: 'output', text: showcasePage.terminalWelcome },
            { type: 'output', text: showcasePage.terminalHint },
          ]
        : current;
    });
    terminalCopyRef.current = {
      welcome: showcasePage.terminalWelcome,
      hint: showcasePage.terminalHint,
    };
  }, [showcasePage.terminalHint, showcasePage.terminalWelcome]);

  useEffect(() => {
    const previousLabel = allFilterLabelRef.current;
    setActiveCategory((current) => current === previousLabel ? showcasePage.allFilterLabel : current);
    allFilterLabelRef.current = showcasePage.allFilterLabel;
  }, [showcasePage.allFilterLabel]);

  // List of unique tags across all projects
  const allTags = [showcasePage.allFilterLabel, ...Array.from(new Set(projects.flatMap((p) => p.tags)))];

  // Filtering projects
  const filteredProjects =
    activeCategory === showcasePage.allFilterLabel
      ? projects
      : projects.filter((p) => p.tags.includes(activeCategory));

  // Handle Terminal CLI commands
  const handleTerminalCommand = (cmdStr: string) => {
    const trimmed = cmdStr.trim().toLowerCase();
    if (!trimmed) return;

    const newHistory = [...terminalHistory, { type: 'cmd' as const, text: cmdStr }];

    let response: string | string[] = '';

    switch (trimmed) {
      case 'help':
        response = showcasePage.terminalHelp;
        break;
      case 'bio':
        response = [
          `Name: ${personalInfo.name}`,
          `Role: ${personalInfo.title}`,
          `Location: ${personalInfo.location}`,
          `About: ${personalInfo.bio}`
        ];
        break;
      case 'skills':
        response = [
          'Technology Stack:',
          ...techStackGroups.map((group) => `  ${group.title}: ${group.items.join(' | ')}`)
        ];
        break;
      case 'experience':
        response = [
          'Professional Milestones:',
          ...personalInfo.experience.flatMap((e) => [
            `  • ${e.year} - ${e.role}`,
            `    ${e.desc}`,
            ''
          ])
        ];
        break;
      case 'contact':
        response = [
          'Reach out via:',
          `  GitHub:  ${personalInfo.github}`,
          ...(personalInfo.email ? [`  Email:   ${personalInfo.email}`] : []),
          ...(personalInfo.twitter ? [`  Twitter: ${personalInfo.twitter}`] : [])
        ];
        break;
      case 'projects':
        response = [
          'Active Creations:',
          ...projects.map((p) => `  • [${p.year}] ${p.title} - ${p.description}`)
        ];
        break;
      case 'clear':
        setTerminalHistory([]);
        setTerminalInput('');
        return;
      default:
        response = `${showcasePage.commandNotFound} (${cmdStr})`;
    }

    setTerminalHistory([...newHistory, { type: 'output', text: response }]);
    setTerminalInput('');

    // Scroll to bottom
    setTimeout(() => {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  };

  const handleTerminalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleTerminalCommand(terminalInput);
  };

  // Custom Card Tilt effect (Pure mathematical calculations, no external heavy libraries)
  const handleCardMouseMove = (e: React.MouseEvent<HTMLDivElement>, cardId: string) => {
    const card = e.currentTarget;
    const box = card.getBoundingClientRect();
    const x = e.clientX - box.left - box.width / 2;
    const y = e.clientY - box.top - box.height / 2;
    // Calculate rotation angles
    const rotateX = -(y / (box.height / 2)) * 10; // Max 10 degrees tilt
    const rotateY = (x / (box.width / 2)) * 10;

    card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;

    // Flare/Reflection calculation
    const shine = card.querySelector('.card-shine') as HTMLElement;
    if (shine) {
      const shineX = (e.clientX - box.left) / box.width * 100;
      const shineY = (e.clientY - box.top) / box.height * 100;
      shine.style.background = `radial-gradient(circle at ${shineX}% ${shineY}%, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 80%)`;
    }
  };

  const handleCardMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    const card = e.currentTarget;
    card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    const shine = card.querySelector('.card-shine') as HTMLElement;
    if (shine) {
      shine.style.background = 'transparent';
    }
  };

  if (selectedProjectKey && !selectedProject) {
    return contentStatus === 'ready'
      ? <RouteNotFound resource="项目" />
      : <RouteContentPending resource="项目" status={contentStatus} />;
  }

  return (
    <section id="home-showcase" className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10 relative z-10">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

        {/* ==========================================
            LEFT COLUMN: Intro, Terminal & Quick Skills
           ========================================== */}
        <div className="lg:col-span-5 space-y-8">
          {/* Main Bio Card */}
          <div className="bg-zinc-950/40 border border-white/[0.05] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <div className="flex items-center space-x-2 text-indigo-400 text-xs font-mono mb-3 uppercase tracking-widest">
              <Sparkles size={12} className="animate-pulse" />
              <span>{showcasePage.identityLabel}</span>
            </div>

            <h1 className="text-3xl font-bold tracking-tight text-white mb-2 font-sans leading-none">
              {personalInfo.name}
            </h1>
            <p className="text-zinc-400 text-sm mb-4 leading-relaxed font-sans font-medium">
              {personalInfo.title}
            </p>

            <div className="flex items-center space-x-2 text-xs text-zinc-400 mb-6">
              <MapPin size={12} className="text-zinc-400" />
              <span>{personalInfo.location}</span>
            </div>

            <p className="text-zinc-300 text-sm leading-relaxed border-l-2 border-indigo-500/50 pl-3 py-1 bg-white/[0.01] rounded-r-lg">
              {personalInfo.bio}
            </p>
          </div>

          {/* Interactive Simulated Terminal (Front-end Flex) */}
          <div className="bg-[#0b0c10] border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl font-mono text-xs text-emerald-400">
            {/* Terminal Window Header */}
            <div className="bg-zinc-900 px-4 py-2.5 flex items-center justify-between border-b border-white/[0.05]">
              <div className="flex items-center space-x-2">
                <TerminalIcon size={14} className="text-indigo-400" />
                <span className="text-zinc-400 font-medium text-[11px] uppercase tracking-wider">{showcasePage.terminalTitle}</span>
              </div>
              <div className="flex space-x-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80 inline-block"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block"></span>
              </div>
            </div>

            {/* Terminal Screen Body */}
            <div className="p-4 h-[220px] overflow-y-auto space-y-2 scrollbar-thin scrollbar-thumb-zinc-800">
              {terminalHistory.map((item, idx) => (
                <div key={idx} className="leading-relaxed">
                  {item.type === 'cmd' ? (
                    <div className="flex items-center text-zinc-400">
                      <span className="text-indigo-400 mr-1.5">{showcasePage.terminalPrompt}</span>
                      <span className="text-white font-medium">{item.text}</span>
                    </div>
                  ) : Array.isArray(item.text) ? (
                    item.text.map((line, lineIdx) => (
                      <div key={lineIdx} className="pl-2 whitespace-pre-wrap text-emerald-400/90">{line}</div>
                    ))
                  ) : (
                    <div className="pl-2 whitespace-pre-wrap text-emerald-400/90">{item.text}</div>
                  )}
                </div>
              ))}
              <div ref={terminalEndRef} />
            </div>

            {/* Quick Actions Buttons Row */}
            <div className="px-4 py-2 bg-zinc-950/80 border-t border-white/[0.04] flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-zinc-400 flex items-center mr-1">
                <Command size={10} className="mr-0.5" /> {showcasePage.quickLabel}
              </span>
              {['bio', 'skills', 'experience', 'projects', 'contact'].map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => handleTerminalCommand(cmd)}
                  className="bg-white/[0.04] hover:bg-indigo-500/10 hover:text-white border border-white/[0.05] hover:border-indigo-500/20 px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer"
                >
                  {cmd}
                </button>
              ))}
            </div>

            {/* Form Input Line */}
            <form onSubmit={handleTerminalSubmit} className="flex items-center bg-zinc-950 px-4 py-2 border-t border-white/[0.05]">
              <span className="text-indigo-400 mr-2 shrink-0">{showcasePage.terminalPrompt}</span>
              <input
                type="text"
                aria-label={showcasePage.terminalPlaceholder}
                value={terminalInput}
                onChange={(e) => setTerminalInput(e.target.value)}
                placeholder={showcasePage.terminalPlaceholder}
                className="bg-transparent border-none outline-none w-full text-white placeholder-zinc-400 font-mono text-xs focus:ring-0 p-0"
              />
              <button type="submit" aria-label="执行终端命令" className="inline-flex size-6 shrink-0 items-center justify-center text-zinc-400 hover:text-indigo-300 transition-colors cursor-pointer">
                <ChevronRight aria-hidden="true" size={14} />
              </button>
            </form>
          </div>

          {/* Visual Skill Matrix Card */}
          <div className="bg-zinc-950/40 border border-white/[0.05] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <div className="flex items-center space-x-2 text-indigo-400 text-xs font-mono mb-4 uppercase tracking-widest">
              <Layers size={12} />
              <span>{showcasePage.technologyTitle}</span>
            </div>
            <div className="space-y-3">
              {techStackGroups.slice(0, 5).map((group) => (
                <div key={group.id} className="space-y-1.5">
                  <span className="text-[10px] font-mono text-indigo-400 uppercase tracking-wider">
                    {group.title}
                  </span>
                  <p className="text-[11px] leading-relaxed text-zinc-300">
                    {group.items.join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ==========================================
            RIGHT COLUMN: Portfolio Projects List
           ========================================== */}
        <div className="lg:col-span-7 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
            <div>
              <div className="flex items-center space-x-2 text-indigo-400 text-xs font-mono mb-1 uppercase tracking-widest">
                <Briefcase size={12} />
                <span>{showcasePage.worksEyebrow}</span>
              </div>
              <h2 className="text-2xl font-bold font-sans text-white">{showcasePage.worksTitle}</h2>
            </div>

            {/* Custom Tag Filters */}
            <div className="flex flex-wrap gap-1 bg-zinc-900/60 p-1 rounded-lg border border-white/[0.04]">
              {allTags.slice(0, 5).map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveCategory(tag)}
                  aria-pressed={activeCategory === tag}
                  className={`px-3 py-1 rounded-md text-[10px] font-mono capitalize transition-all cursor-pointer ${
                    activeCategory === tag
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                      : 'text-zinc-400 hover:text-white hover:bg-white/[0.03]'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* Interactive Project Cards */}
          <div className="grid grid-cols-1 gap-6">
            <AnimatePresence mode="popLayout">
              {filteredProjects.map((project) => (
                <motion.div
                  key={project.id}
                  layout
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                  onMouseMove={(e) => handleCardMouseMove(e, project.id)}
                  onMouseLeave={handleCardMouseLeave}
                  className="group relative bg-zinc-950/30 hover:bg-zinc-950/60 border border-white/[0.04] hover:border-indigo-500/30 rounded-2xl transition-all duration-300 backdrop-blur-sm overflow-hidden"
                  style={{ transformStyle: 'preserve-3d' }}
                >
                  {/* Subtle Card Glow Reflection Background */}
                  <div className="card-shine absolute inset-0 pointer-events-none transition-all duration-300" />
                  <Link
                    to={projectPath(project)}
                    aria-label={`查看项目详情：${project.title}`}
                    className="relative block p-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                    style={{ transform: 'translateZ(30px)' }}
                  >
                    {/* High tech top-right dynamic marker */}
                    <span className="absolute right-6 top-6 flex items-center space-x-2 text-[10px] font-mono text-zinc-400 group-hover:text-indigo-300 transition-colors">
                      <span>{project.year}</span>
                      <Maximize2 size={10} aria-hidden="true" />
                    </span>

                    {/* Card Content with 3D Depth transform */}
                    <div className="space-y-4">
                    {/* Tags row */}
                    <div className="flex flex-wrap gap-1.5">
                      {project.tags.map((t) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 rounded bg-zinc-900 border border-white/[0.03] text-[9px] font-mono text-zinc-400"
                        >
                          {t}
                        </span>
                      ))}
                    </div>

                    {/* Title */}
                    <h3 className="text-lg font-bold text-white group-hover:text-indigo-300 transition-colors font-sans">
                      {project.title}
                    </h3>

                    {/* Description */}
                    <p className="text-zinc-400 text-xs leading-relaxed max-w-xl">
                      {project.description}
                    </p>

                    {/* Quick Stats Footnote (COUNT-UP style detail) */}
                    <div className="pt-4 border-t border-white/[0.04] flex items-center justify-between text-[10px] font-mono text-zinc-400">
                      <div className="flex items-center space-x-4">
                        {project.stats.stars && (
                          <span className="flex items-center">
                            <Github size={11} className="mr-1 text-zinc-400" />
                            Stars: <span className="text-white ml-0.5">{project.stats.stars}</span>
                          </span>
                        )}
                        {project.stats.impact && (
                          <span className="flex items-center">
                            <Award size={11} className="mr-1 text-zinc-400" />
                            {project.stats.impact}
                          </span>
                        )}
                      </div>
                      <span className="text-indigo-300 group-hover:translate-x-1 transition-transform inline-flex items-center font-medium">
                        {showcasePage.detailsLabel} <ChevronRight size={12} />
                      </span>
                    </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ==========================================
          MODAL DETAILED CARD PANEL (3D-like transition)
         ========================================== */}
      <AnimatePresence>
        {selectedProject && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Dark glass overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeProject}
              aria-hidden="true"
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />

            {/* Modal Body Container */}
            <motion.div
              ref={projectDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={projectTitleId}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-zinc-950 border border-white/[0.08] rounded-2xl shadow-2xl z-10 scrollbar-thin scrollbar-thumb-zinc-800"
            >
              {/* Close Button */}
              <button
                ref={projectCloseRef}
                id="close-project-modal"
                onClick={closeProject}
                aria-label="关闭项目详情"
                className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-white bg-zinc-900 hover:bg-zinc-850 rounded-lg transition-colors cursor-pointer z-20"
              >
                <X size={14} />
              </button>

              <div className="p-5 sm:p-8 space-y-4 sm:space-y-6">
                {/* Header info */}
                <div className="space-y-2">
                  <div className="flex items-center space-x-3 text-xs font-mono text-indigo-400">
                    <span>{selectedProject.year}</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                    <span>{selectedProject.role}</span>
                  </div>
                  <h3 id={projectTitleId} className="text-2xl font-bold font-sans text-white pr-8">
                    {selectedProject.title}
                  </h3>
                </div>

                {/* Tags row */}
                <div className="flex flex-wrap gap-1.5">
                  {selectedProject.tags.map((t) => (
                    <span
                      key={t}
                      className="px-2.5 py-1 rounded bg-zinc-900 border border-white/[0.05] text-[10px] font-mono text-zinc-300"
                    >
                      {t}
                    </span>
                  ))}
                </div>

                {/* In-depth descriptions */}
                <div className="space-y-4">
                  <p className="text-zinc-300 text-xs leading-relaxed">
                    {selectedProject.longDescription || selectedProject.description}
                  </p>
                </div>

                {/* Core Impact Statistics */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 p-4 rounded-xl bg-zinc-900/50 border border-white/[0.03] text-center">
                  <div>
                    <span className="block text-[10px] font-mono text-zinc-400 uppercase">{showcasePage.impactLabel}</span>
                    <span className="text-sm font-semibold font-mono text-indigo-300 mt-1 block">
                      {selectedProject.stats.impact || "N/A"}
                    </span>
                  </div>
                  {selectedProject.stats.stars && (
                    <div>
                      <span className="block text-[10px] font-mono text-zinc-400 uppercase">{showcasePage.starsLabel}</span>
                      <span className="text-sm font-semibold font-mono text-white mt-1 block">
                        {selectedProject.stats.stars}
                      </span>
                    </div>
                  )}
                  {selectedProject.stats.forks && (
                    <div>
                      <span className="block text-[10px] font-mono text-zinc-400 uppercase">{showcasePage.forksLabel}</span>
                      <span className="text-sm font-semibold font-mono text-white mt-1 block">
                        {selectedProject.stats.forks}
                      </span>
                    </div>
                  )}
                </div>

                {/* Footer buttons link */}
                <div className="flex items-center space-x-3 pt-4 border-t border-white/[0.05]">
                  {selectedProject.github && (
                    <a
                      href={selectedProject.github}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-850 border border-white/[0.05] text-xs font-medium text-white rounded-lg transition-colors"
                    >
                      <Github size={14} /> {showcasePage.repositoryLabel}
                    </a>
                  )}
                  {selectedProject.url && (
                    <a
                      href={selectedProject.url}
                      className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors shadow-lg shadow-indigo-600/10"
                    >
                      {showcasePage.livePreviewLabel} <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </section>
  );
}
