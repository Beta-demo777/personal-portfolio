import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bot, Send, User, Sparkles, AlertCircle, RefreshCw, MessageSquare, Volume2 } from "lucide-react";
import { useSiteContent } from "../content";
import {
  MAX_AGENT_USER_MESSAGE_CHARS,
  agentErrorMessage,
  agentReply,
  boundedAgentHistory,
} from "../api/agent";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function AgentSection() {
  const { agentPage, personalInfo } = useSiteContent();
  const displayName = agentPage.displayName.replace(/\{name\}/g, personalInfo.name);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: agentPage.welcomeMessage,
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live2D State Variables
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isBlinking, setIsBlinking] = useState(false);
  const [bubbleText, setBubbleText] = useState(agentPage.initialBubble);
  const [bubbleVisible, setBubbleVisible] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const initialCopyRef = useRef({
    welcomeMessage: agentPage.welcomeMessage,
    initialBubble: agentPage.initialBubble,
  });

  useEffect(() => {
    const previousCopy = initialCopyRef.current;
    setMessages((current) => {
      if (current.length !== 1 || current[0]?.id !== "welcome" || current[0].content !== previousCopy.welcomeMessage) {
        return current;
      }
      return [{ ...current[0], content: agentPage.welcomeMessage }];
    });
    setBubbleText((current) => current === previousCopy.initialBubble ? agentPage.initialBubble : current);
    initialCopyRef.current = {
      welcomeMessage: agentPage.welcomeMessage,
      initialBubble: agentPage.initialBubble,
    };
  }, [agentPage.initialBubble, agentPage.welcomeMessage]);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
    requestControllerRef.current?.abort();
  }, []);

  // Auto-scroll to the bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Keep pointer-driven rendering to at most one React update per frame.
  useEffect(() => {
    let animationFrame: number | null = null;
    let pointerX = 0;
    let pointerY = 0;

    const updateGaze = () => {
      animationFrame = null;
      if (!avatarRef.current) return;
      const rect = avatarRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Calculate delta normalized to a sensible max/min range
      const dx = pointerX - centerX;
      const dy = pointerY - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Limit gaze offset to max 20px
      const limit = 20;
      let targetX = 0;
      let targetY = 0;

      if (distance > 0) {
        const factor = Math.min(distance, 400) / 400; // sensitivity falloff
        targetX = (dx / distance) * limit * factor;
        targetY = (dy / distance) * limit * factor;
      }

      setMousePos({ x: targetX, y: targetY });
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(updateGaze);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  // Automatic eye blinking effect
  useEffect(() => {
    let blinkTimeout: ReturnType<typeof setTimeout> | null = null;
    const blinkInterval = setInterval(() => {
      setIsBlinking(true);
      blinkTimeout = setTimeout(() => {
        setIsBlinking(false);
      }, 150); // Blink duration
    }, 4000); // Blink cycle

    return () => {
      clearInterval(blinkInterval);
      if (blinkTimeout !== null) clearTimeout(blinkTimeout);
    };
  }, []);

  // Sync bubble text when AI is thinking
  useEffect(() => {
    if (isLoading) {
      setBubbleText(agentPage.loadingBubble);
      setBubbleVisible(true);
    } else if (messages.length > 1) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        setBubbleText(agentPage.answeredBubble);
        setBubbleVisible(true);
        // Hide bubble after 5 seconds to reduce clutter
        const timer = setTimeout(() => {
          setBubbleVisible(false);
        }, 5000);
        return () => clearTimeout(timer);
      }
    }
  }, [agentPage.answeredBubble, agentPage.loadingBubble, isLoading, messages]);

  const handleSend = async (textToSend: string) => {
    const normalizedText = textToSend.trim();
    if (!normalizedText || isLoading) return;
    if (normalizedText.length > MAX_AGENT_USER_MESSAGE_CHARS) {
      setError(`单条消息不能超过 ${MAX_AGENT_USER_MESSAGE_CHARS} 个字符。`);
      return;
    }

    setError(null);
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: normalizedText,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    requestControllerRef.current = controller;

    try {
      const historyPayload = boundedAgentHistory([...messages, userMessage]);

      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: historyPayload }),
        signal: controller.signal,
      });

      if (requestGeneration !== requestGenerationRef.current) return;

      if (!response.ok) {
        throw new Error(await agentErrorMessage(response));
      }

      const data: unknown = await response.json();
      const reply = agentReply(data);
      if (!reply) throw new Error("AI 返回了无法识别的响应，请稍后重试。");

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: reply,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: unknown) {
      if (controller.signal.aborted || requestGeneration !== requestGenerationRef.current) return;
      console.error("Chat error:", err);
      setError(err instanceof Error ? err.message : "请求失败，请稍后重试");
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        requestControllerRef.current = null;
        setIsLoading(false);
      }
    }
  };

  const clearChat = () => {
    requestGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setIsLoading(false);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content: agentPage.welcomeMessage,
      },
    ]);
    setError(null);
    setBubbleText(agentPage.resetBubble);
    setBubbleVisible(true);
  };

  const handleAvatarClick = () => {
    if (agentPage.funQuotes.length === 0) {
      setBubbleText(agentPage.initialBubble);
      setBubbleVisible(Boolean(agentPage.initialBubble));
      return;
    }
    const randomIndex = Math.floor(Math.random() * agentPage.funQuotes.length);
    setBubbleText(agentPage.funQuotes[randomIndex]);
    setBubbleVisible(true);
  };

  return (
    <section id="ai-agent-section" className="max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-5 lg:py-4 relative z-10">

      {/* Ambient Mesh Glow Backgrounds (添加一个动态微光背景) */}
      <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none rounded-3xl">
        {/* Soft floating dynamic meshes */}
        <div className="absolute top-[5%] left-[10%] w-[380px] h-[380px] bg-indigo-500/[0.04] rounded-full blur-[90px] animate-pulse" style={{ animationDuration: '7s' }} />
        <div className="absolute bottom-[10%] right-[15%] w-[420px] h-[420px] bg-purple-500/[0.05] rounded-full blur-[110px] animate-pulse" style={{ animationDuration: '10s', animationDelay: '1.5s' }} />
        <div className="absolute top-[45%] left-[30%] w-[280px] h-[280px] bg-pink-500/[0.03] rounded-full blur-[80px] animate-pulse" style={{ animationDuration: '9s', animationDelay: '3s' }} />

        {/* Tech Cyber Grid Overlay behind the section */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.01)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.01)_1px,transparent_1px)] bg-[size:32px_32px] opacity-40" />
      </div>

      {/* Title & Description Header */}
      <div className="text-center mb-5 lg:mb-4">
        <h1 className="text-2xl font-bold font-sans text-white tracking-tight sm:text-3xl">
          {agentPage.title}
        </h1>
        <p className="mt-1.5 text-xs sm:text-sm text-zinc-400 max-w-lg mx-auto font-sans leading-snug">
          {agentPage.description}
        </p>
      </div>

      {/* Dual Column Layout: Left Column Live2D / Right Column Chat Interface */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-6 items-stretch relative">

        {/* =========================================================
            LEFT COLUMN: LIVE2D VIRTUAL COMPANION (交互式人形智能体)
           ========================================================= */}
        <div className="lg:col-span-5 flex flex-col items-center justify-between bg-zinc-950/40 border border-white/[0.05] hover:border-indigo-500/20 rounded-2xl p-4 lg:p-5 backdrop-blur-md relative overflow-hidden group transition-all duration-500 min-h-[480px] lg:min-h-[420px] lg:h-[calc(100vh-300px)] lg:max-h-[520px] shadow-2xl">

          {/* Futuristic corner frame decals */}
          <div className="absolute top-3 left-3 w-3 h-3 border-t border-l border-white/20" />
          <div className="absolute top-3 right-3 w-3 h-3 border-t border-r border-white/20" />
          <div className="absolute bottom-3 left-3 w-3 h-3 border-b border-l border-white/20" />
          <div className="absolute bottom-3 right-3 w-3 h-3 border-b border-r border-white/20" />

          {/* Cyber hologram grid scan line */}
          <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/0 via-indigo-500/[0.015] to-indigo-500/0 pointer-events-none animate-[scan_6s_linear_infinite]" />

          {/* Top Status Indicators */}
          <div className="w-full flex items-center justify-between z-10">
            <div className="flex items-center space-x-2">
              <span className={`w-1.5 h-1.5 rounded-full ${isLoading ? 'bg-amber-400 animate-ping' : 'bg-emerald-400 animate-pulse'}`} />
              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">
                {isLoading ? agentPage.loadingStatus : agentPage.idleStatus}
              </span>
            </div>
            <div className="text-[9px] font-mono text-zinc-500">
              GAZE_LOCK: {(mousePos.x).toFixed(1)}°, {(mousePos.y).toFixed(1)}°
            </div>
          </div>

          {/* Dynamic Speech Bubble */}
          <div className="w-full relative min-h-[70px] flex items-center justify-center mt-2 z-10">
            <AnimatePresence mode="wait">
              {bubbleVisible && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="w-full bg-zinc-900/90 border border-indigo-500/20 rounded-xl px-4 py-2.5 text-xs text-zinc-300 font-sans shadow-lg text-center relative"
                >
                  {/* Bubble Pointer triangle */}
                  <div className="absolute bottom-[-6px] left-1/2 transform -translate-x-1/2 w-3 h-3 bg-zinc-900 border-r border-b border-indigo-500/20 rotate-45" />
                  <p className="leading-relaxed">{bubbleText}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Interactive Gaze-Tracking Vector Character Stage */}
          <div
            ref={avatarRef}
            className="group/avatar relative flex h-[240px] w-full select-none items-center justify-center lg:h-[250px]"
          >
            <button
              type="button"
              onClick={handleAvatarClick}
              aria-label={`与 ${displayName} 互动`}
              className="absolute inset-0 z-20 cursor-pointer rounded-lg border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
              title="点点我，有惊喜哦！"
            />
            {/* Hologram Circle background rings rotating slowly */}
            <div className="absolute w-48 h-48 rounded-full border border-indigo-500/10 border-dashed animate-[spin_20s_linear_infinite]" />
            <div className="absolute w-56 h-56 rounded-full border border-purple-500/5 animate-[spin_35s_linear_infinite_reverse]" />

            {/* Glowing avatar shadow projection */}
            <div className="absolute bottom-2 w-32 h-6 bg-indigo-500/10 rounded-full blur-md animate-pulse" />

            {/* Vector Character Canvas Container */}
            <div
              className="agent-avatar-float relative w-44 h-48 transition-transform duration-300 ease-out"
              style={{
                transform: `rotateY(${mousePos.x * 0.7}deg) rotateX(${-mousePos.y * 0.7}deg)`,
              }}
            >
              <svg viewBox="0 0 200 220" className="w-full h-full drop-shadow-[0_10px_15px_rgba(99,102,241,0.15)]">
                {/* Headphones Band */}
                <path
                  d="M45,100 A55,55 0 0,1 155,100"
                  fill="none"
                  stroke="rgba(99, 102, 241, 0.4)"
                  strokeWidth="8"
                  strokeLinecap="round"
                />

                {/* Back Hair */}
                <path d="M48,110 Q100,50 152,110 L155,150 L45,150 Z" fill="#18181b" />

                {/* Neck */}
                <rect x="90" y="145" width="20" height="30" fill="#2d2d30" rx="3" />
                <path d="M85,170 L115,170 L125,190 L75,190 Z" fill="#3f3f46" /> {/* Cyber jacket collar */}

                {/* Face Mask Base */}
                <path d="M60,105 Q100,165 140,105 L135,80 L65,80 Z" fill="#27272a" />

                {/* Left/Right Cyber Ear Cup plates */}
                <circle cx="45" cy="110" r="14" fill="#3f3f46" />
                <circle cx="45" cy="110" r="8" fill="#18181b" />
                <circle cx="45" cy="110" r="4" fill={isLoading ? "#f59e0b" : "#10b981"} className="animate-pulse" />

                <circle cx="155" cy="110" r="14" fill="#3f3f46" />
                <circle cx="155" cy="110" r="8" fill="#18181b" />
                <circle cx="155" cy="110" r="4" fill={isLoading ? "#f59e0b" : "#10b981"} className="animate-pulse" />

                {/* Gaze-locked Face Elements Container */}
                <g
                  style={{
                    transform: `translate(${mousePos.x * 0.45}px, ${mousePos.y * 0.45}px)`
                  }}
                >
                  {/* Forehead Hologram visor Decal */}
                  <path d="M70,80 L130,80 L125,90 L75,90 Z" fill="rgba(99, 102, 241, 0.15)" />

                  {/* Left Eye */}
                  <g transform="translate(78, 105)">
                    <ellipse cx="0" cy="0" rx="10" ry="6" fill="#18181b" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                    {isBlinking ? (
                      // Blink state - flat thin path representing closed eye
                      <line x1="-11" y1="0" x2="11" y2="0" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" />
                    ) : (
                      // Open eye with iris shifting with mouse positions
                      <circle
                        cx={mousePos.x * 0.18}
                        cy={mousePos.y * 0.18}
                        r="4.5"
                        fill="#818cf8"
                      />
                    )}
                  </g>

                  {/* Right Eye */}
                  <g transform="translate(122, 105)">
                    <ellipse cx="0" cy="0" rx="10" ry="6" fill="#18181b" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                    {isBlinking ? (
                      <line x1="-11" y1="0" x2="11" y2="0" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" />
                    ) : (
                      <circle
                        cx={mousePos.x * 0.18}
                        cy={mousePos.y * 0.18}
                        r="4.5"
                        fill="#818cf8"
                      />
                    )}
                  </g>

                  {/* Glowing cyber cheeks */}
                  <ellipse cx="70" cy="118" rx="5" ry="1.5" fill="rgba(236,72,153,0.25)" className="blur-[1px]" />
                  <ellipse cx="130" cy="118" rx="5" ry="1.5" fill="rgba(236,72,153,0.25)" className="blur-[1px]" />

                  {/* Cyber Nose line */}
                  <line x1="100" y1="110" x2="100" y2="118" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeLinecap="round" />

                  {/* Mouth with reactive states */}
                  {isLoading ? (
                    // Thinking talking bubble scale animation mouth
                    <ellipse
                      cx="100"
                      cy="128"
                      rx="3"
                      ry="2"
                      fill="#818cf8"
                    >
                      <animate attributeName="ry" values="2;4.5;2" dur="0.6s" repeatCount="indefinite" />
                    </ellipse>
                  ) : (
                    // Calm curve smile path
                    <path
                      d="M94,126 Q100,131 106,126"
                      fill="none"
                      stroke="#818cf8"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  )}
                </g>

                {/* Sleek frontal cyber bangs hair overlay */}
                <path d="M60,80 Q100,60 140,80 Q120,95 100,90 Q80,95 60,80 Z" fill="#202024" />
                <path d="M55,80 L65,100 Q70,95 75,80 Z" fill="#202024" />
                <path d="M145,80 L135,100 Q130,95 125,80 Z" fill="#202024" />
              </svg>
            </div>
          </div>

          {/* Micro-Interaction Tips */}
          <div className="w-full text-center mt-2 bg-zinc-900/30 p-2 rounded-xl border border-white/[0.02]">
            <p className="text-[10px] text-zinc-500 font-mono flex items-center justify-center gap-1">
              <Volume2 size={11} className="text-indigo-400" />
              <span>{agentPage.interactionHint}</span>
            </p>
          </div>
        </div>

        {/* =========================================================
            RIGHT COLUMN: CHAT WINDOW HUB (对话界面右移)
           ========================================================= */}
        <div className="lg:col-span-7 bg-zinc-950/45 border border-white/[0.06] rounded-2xl shadow-2xl backdrop-blur-md overflow-hidden flex flex-col h-[500px] lg:min-h-[420px] lg:h-[calc(100vh-300px)] lg:max-h-[520px] hover:border-indigo-500/20 transition-all duration-500">

          {/* Chat Header Area */}
          <div className="bg-zinc-900/60 px-5 py-3 border-b border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="relative flex items-center justify-center w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 p-[1px]">
                <div className="w-full h-full bg-zinc-950 rounded-full flex items-center justify-center text-indigo-400">
                  <Bot size={18} />
                </div>
                <span className="absolute bottom-0 right-0 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
              </div>
              <div>
                <div className="flex items-center space-x-1.5">
                  <span className="text-sm font-semibold text-white">{displayName}</span>
                  <span className="text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 uppercase tracking-widest">
                    {agentPage.badgeLabel}
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 font-mono">{agentPage.modelLabel}</p>
              </div>
            </div>

            <button
              id="clear-chat-btn"
              onClick={clearChat}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono text-zinc-400 hover:text-white hover:bg-white/[0.05] border border-white/[0.03] transition-colors cursor-pointer"
              title={agentPage.resetLabel}
            >
              <RefreshCw size={11} />
              <span>{agentPage.resetLabel}</span>
            </button>
          </div>

          {/* Message Panel Scroller */}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label="AI 对话消息"
            tabIndex={0}
            className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-zinc-800"
          >
            <AnimatePresence initial={false}>
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  id={`chat-msg-${msg.id}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className={`flex gap-4 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  {/* Avatar Icon */}
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center border shrink-0 ${
                      msg.role === "user"
                        ? "bg-zinc-900 border-white/[0.1] text-zinc-300"
                        : "bg-indigo-950/50 border-indigo-500/30 text-indigo-400"
                    }`}
                  >
                    {msg.role === "user" ? <User size={14} /> : <Bot size={14} />}
                  </div>

                  {/* Message Bubble text rendering with Markdown-like formatting */}
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-indigo-600/90 text-white font-medium rounded-tr-none shadow-md shadow-indigo-600/10"
                        : "bg-zinc-900/60 border border-white/[0.04] text-zinc-200 rounded-tl-none whitespace-pre-wrap"
                    }`}
                  >
                    {/* Parse basic markdown highlights */}
                    {msg.role === "assistant" ? (
                      msg.content.split("\n").map((line, lineIndex) => {
                        let processed = line;
                        const isBullet = processed.trim().startsWith("- ");
                        if (isBullet) {
                          processed = processed.replace("- ", "");
                        }

                        // Simple regex bold replacement **bold** -> <strong>
                        const parts = processed.split(/\*\*(.*?)\*\*/g);
                        const contentNode = parts.map((part, index) => {
                          if (index % 2 === 1) {
                            return <strong key={index} className="text-white font-semibold">{part}</strong>;
                          }
                          return part;
                        });

                        return (
                          <div key={lineIndex} className={isBullet ? "flex items-start gap-1.5 pl-2 mb-1" : "mb-1.5 last:mb-0"}>
                            {isBullet && <span className="text-indigo-400 shrink-0 mt-1.5">•</span>}
                            <span>{contentNode}</span>
                          </div>
                        );
                      })
                    ) : (
                      msg.content
                    )}
                  </div>
                </motion.div>
              ))}

              {/* AI Response Loading bubble */}
              {isLoading && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex gap-4"
                >
                  <div className="w-8 h-8 rounded-full flex items-center justify-center bg-indigo-950/50 border border-indigo-500/30 text-indigo-400 shrink-0">
                    <Bot size={14} />
                  </div>
                  <div className="bg-zinc-900/40 border border-white/[0.03] rounded-2xl rounded-tl-none px-4 py-3 flex items-center space-x-1.5">
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></span>
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></span>
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></span>
                  </div>
                </motion.div>
              )}

              {/* Error Message Bubble */}
              {error && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex justify-center"
                >
                  <div className="flex items-center space-x-2 bg-red-950/40 border border-red-500/20 px-4 py-2.5 rounded-xl text-red-300 text-xs font-mono shadow-lg">
                    <AlertCircle size={13} />
                    <span>{error}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div ref={messagesEndRef} />
          </div>

          {/* Dynamic sample questions grid */}
          {messages.length <= 2 && !isLoading && (
            <div className="px-6 py-3 border-t border-white/[0.04] bg-black/10">
              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block mb-2">{agentPage.suggestionsTitle}</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {agentPage.samplePrompts.map((prompt, i) => (
                  <button
                    key={i}
                    id={`sample-prompt-btn-${i}`}
                    onClick={() => handleSend(prompt.text)}
                    className="group flex flex-col items-start p-2 rounded-xl border border-white/[0.03] bg-zinc-950/30 hover:bg-zinc-950/80 hover:border-indigo-500/30 transition-all text-left cursor-pointer active:scale-[0.98]"
                  >
                    <span className="text-[9px] font-mono text-indigo-400 font-medium tracking-wide uppercase mb-0.5 group-hover:text-indigo-300">
                      {prompt.label}
                    </span>
                    <p className="text-xs text-zinc-400 group-hover:text-zinc-200 line-clamp-1">
                      {prompt.text}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input Controls Bar */}
          <form
            id="chat-input-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(input);
            }}
            className="border-t border-white/[0.05] p-4 bg-zinc-950/60 flex items-center space-x-3"
          >
            <input
              id="chat-input-field"
              type="text"
              aria-label="输入发送给 AI 的消息"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={MAX_AGENT_USER_MESSAGE_CHARS}
              placeholder={agentPage.inputPlaceholder}
              disabled={isLoading}
              className="flex-grow bg-zinc-900 border border-white/[0.05] rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-300 placeholder:opacity-100 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all disabled:opacity-50"
            />
            <button
              id="chat-send-btn"
              type="submit"
              disabled={isLoading || !input.trim()}
              aria-label="发送消息"
              className="flex items-center justify-center w-11 h-11 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 hover:shadow-[0_0_20px_rgba(99,102,241,0.25)] transition-all cursor-pointer disabled:opacity-50 disabled:hover:bg-indigo-600 disabled:hover:shadow-none shrink-0"
              title="Send Message"
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
