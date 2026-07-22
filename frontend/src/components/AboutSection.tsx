import React, { useState } from 'react';
import {
  Compass,
  Briefcase,
  Layers,
  Heart,
  MessageSquare,
  Send,
  Coffee,
  Code2,
  Gamepad2,
  Tv
} from 'lucide-react';
import { useSiteContent } from '../content';

const HOBBY_ICON_MAP = {
  coffee: { Icon: Coffee, colorClass: 'text-amber-400' },
  code: { Icon: Code2, colorClass: 'text-indigo-400' },
  game: { Icon: Gamepad2, colorClass: 'text-emerald-400' },
  screen: { Icon: Tv, colorClass: 'text-pink-400' },
} as const;

const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CONTACT_NAME_LENGTH = 80;
const MAX_CONTACT_MESSAGE_LENGTH = 1000;
const MAX_MAILTO_URL_LENGTH = 7000;

type ContactStatus = {
  tone: 'status' | 'error';
  message: string;
} | null;

export default function AboutSection() {
  const { personalInfo, techStackGroups, aboutPage } = useSiteContent();
  const [contactName, setContactName] = useState('');
  const [contactMessage, setContactMessage] = useState('');
  const [contactStatus, setContactStatus] = useState<ContactStatus>(null);
  const contactEmail = typeof personalInfo.email === 'string' ? personalInfo.email.trim() : '';
  const contactEmailAvailable = BASIC_EMAIL_PATTERN.test(contactEmail);

  const handleContactSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const senderName = contactName.trim();
    const message = contactMessage.trim();

    if (!contactEmailAvailable) {
      setContactStatus({ tone: 'error', message: '暂未配置可用的联系邮箱，邮件联系功能当前不可用。' });
      return;
    }
    if (!senderName || !message) {
      setContactStatus({ tone: 'error', message: '请填写称呼和消息内容。' });
      return;
    }
    if (senderName.length > MAX_CONTACT_NAME_LENGTH || message.length > MAX_CONTACT_MESSAGE_LENGTH) {
      setContactStatus({ tone: 'error', message: '称呼或消息内容过长，请精简后重试。' });
      return;
    }

    const recipientName = typeof personalInfo.name === 'string' && personalInfo.name.trim()
      ? personalInfo.name.trim()
      : '站点管理员';
    const subject = `来自 ${senderName} 的作品集联系`;
    const body = `你好 ${recipientName}，\n\n${message}\n\n—— ${senderName}`;
    const encodedRecipient = encodeURIComponent(contactEmail).replace(/%40/i, '@');
    const mailtoUrl = `mailto:${encodedRecipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (mailtoUrl.length > MAX_MAILTO_URL_LENGTH) {
      setContactStatus({ tone: 'error', message: '消息编码后过长，邮件客户端可能无法打开，请精简后重试。' });
      return;
    }

    setContactStatus({ tone: 'status', message: '已打开默认邮件客户端并创建草稿，请在邮件客户端中确认并发送。' });
    window.location.href = mailtoUrl;
  };

  return (
    <section id="about-section" className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10 relative z-10 space-y-12">
      {/* Introduction Header Banner */}
      <div className="space-y-4 text-center max-w-xl mx-auto mb-10">
        <span className="text-indigo-400 font-mono text-xs uppercase tracking-widest block">
          {aboutPage.eyebrow}
        </span>
        <h1 className="text-3xl font-bold font-sans text-white">{aboutPage.title}</h1>
        <p className="text-zinc-400 text-xs leading-relaxed">
          {aboutPage.description}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
        {/* ==========================================
            LEFT PANEL: Timeline & Hobbies
           ========================================== */}
        <div className="md:col-span-7 space-y-8">
          {/* Personal introduction */}
          <div className="bg-zinc-950/40 border border-white/[0.04] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <h3 className="text-base font-semibold font-sans text-white mb-4 flex items-center gap-2">
              <Compass size={16} className="text-indigo-400" />
              {aboutPage.introductionTitle}
            </h3>
            <div className="space-y-3 text-zinc-300 text-xs leading-relaxed">
              {aboutPage.introduction.map((paragraph, index) => (
                <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
              ))}
            </div>
          </div>

          {/* Professional Experience Timeline */}
          <div className="bg-zinc-950/40 border border-white/[0.04] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <h3 className="text-base font-semibold font-sans text-white mb-6 flex items-center gap-2">
              <Briefcase size={16} className="text-indigo-400" />
              {aboutPage.experienceTitle}
            </h3>

            <div className="space-y-6 relative border-l border-zinc-800 ml-2.5 pl-5">
              {personalInfo.experience.map((exp, idx) => (
                <div key={idx} className="relative group">
                  {/* Timeline bullet dot */}
                  <div className="absolute -left-[26px] top-1 w-3 h-3 rounded-full bg-zinc-900 border-2 border-indigo-500 group-hover:bg-indigo-400 group-hover:scale-125 transition-all" />

                  <span className="text-[10px] font-mono text-indigo-400 font-semibold uppercase">
                    {exp.year}
                  </span>
                  <h4 className="text-sm font-semibold text-white mt-1 group-hover:text-indigo-300 transition-colors">
                    {exp.role}
                  </h4>
                  <p className="text-zinc-400 text-xs mt-2 leading-relaxed">
                    {exp.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Hobbies / Lifestyle Grid */}
          <div className="bg-zinc-950/40 border border-white/[0.04] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <h3 className="text-base font-semibold font-sans text-white mb-4 flex items-center gap-2">
              <Heart size={16} className="text-indigo-400" />
              {aboutPage.hobbiesTitle}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              {aboutPage.hobbies.map((hobby) => {
                const iconConfig = HOBBY_ICON_MAP[hobby.icon] || HOBBY_ICON_MAP.code;
                const HobbyIcon = iconConfig.Icon;
                return (
                  <div key={hobby.id} className="p-3 bg-zinc-900/30 border border-white/[0.02] rounded-xl flex items-center gap-3">
                    <HobbyIcon size={18} className={`${iconConfig.colorClass} shrink-0`} />
                    <div>
                      <span className="block font-medium text-white">{hobby.title}</span>
                      <span className="text-[10px] text-zinc-400">{hobby.description}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ==========================================
            RIGHT PANEL: Interactive Skills & Secure Msg
           ========================================== */}
        <div className="md:col-span-5 space-y-8">
          {/* Complete technology stack */}
          <div className="bg-zinc-950/40 border border-white/[0.04] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <h3 className="text-base font-semibold font-sans text-white mb-4 flex items-center gap-2">
              <Layers size={16} className="text-indigo-400" />
              {aboutPage.technologyTitle}
            </h3>

            <div className="space-y-4">
              {techStackGroups.map((group) => (
                <div key={group.id} className="space-y-2">
                  <span className="block text-[10px] font-mono text-indigo-400 uppercase tracking-wider">
                    {group.title}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {group.items.map((item) => (
                      <span
                        key={item}
                        className="px-2 py-1 rounded-md border border-white/[0.05] bg-zinc-900/70 text-[10px] text-zinc-300"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Secure Interactive Message terminal card */}
          <div className="bg-zinc-950/40 border border-white/[0.04] p-6 rounded-2xl backdrop-blur-sm shadow-xl">
            <div className="flex items-center space-x-2 text-indigo-400 text-xs font-mono mb-3 uppercase tracking-widest">
              <MessageSquare size={13} />
              <span>{aboutPage.contactEyebrow}</span>
            </div>

            <h3 className="text-base font-semibold font-sans text-white mb-2">
              {aboutPage.contactTitle}
            </h3>
            <p className="text-zinc-400 text-[10px] font-mono leading-relaxed mb-4">
              {aboutPage.contactDescription}
            </p>

            <form onSubmit={handleContactSubmit} className="space-y-3 text-xs">
              <div className="space-y-1">
                <label htmlFor="contact-name" className="block text-xs font-medium text-zinc-300">
                  {aboutPage.contactNamePlaceholder}
                </label>
                <input
                  id="contact-name"
                  type="text"
                  placeholder={aboutPage.contactNamePlaceholder}
                  value={contactName}
                  onChange={(e) => { setContactName(e.target.value); setContactStatus(null); }}
                  maxLength={MAX_CONTACT_NAME_LENGTH}
                  className="w-full bg-zinc-950/50 border border-white/[0.05] hover:border-white/[0.1] rounded-xl px-4 py-2.5 text-xs text-white placeholder-zinc-600 outline-none focus:border-indigo-500/50 transition-all"
                  required
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="contact-message" className="block text-xs font-medium text-zinc-300">
                  {aboutPage.contactMessagePlaceholder}
                </label>
                <textarea
                  id="contact-message"
                  placeholder={aboutPage.contactMessagePlaceholder}
                  value={contactMessage}
                  onChange={(e) => { setContactMessage(e.target.value); setContactStatus(null); }}
                  maxLength={MAX_CONTACT_MESSAGE_LENGTH}
                  rows={3}
                  className="w-full bg-zinc-950/50 border border-white/[0.05] hover:border-white/[0.1] rounded-xl px-4 py-2.5 text-xs text-white placeholder-zinc-600 outline-none focus:border-indigo-500/50 transition-all resize-none"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={!contactEmailAvailable}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 text-xs"
              >
                <Send size={13} />
                <span>{contactEmailAvailable ? aboutPage.contactSubmitLabel : '邮件联系暂不可用'}</span>
              </button>
              {!contactEmailAvailable && (
                <p role="status" className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2.5 text-[10px] leading-relaxed text-amber-200/80">
                  站点尚未配置联系邮箱，暂时无法创建邮件草稿。
                </p>
              )}
              {contactStatus && (
                <p
                  role={contactStatus.tone === 'error' ? 'alert' : 'status'}
                  aria-live={contactStatus.tone === 'error' ? 'assertive' : 'polite'}
                  className={`rounded-lg border px-3 py-2.5 text-[10px] leading-relaxed ${contactStatus.tone === 'error' ? 'border-rose-400/15 bg-rose-400/[0.06] text-rose-200/80' : 'border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-200/80'}`}
                >
                  {contactStatus.message}
                </p>
              )}
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
