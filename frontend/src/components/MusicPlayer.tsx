import React, { useCallback, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Music, Play, Pause, Volume2, VolumeX, Minimize2, Radio, Sparkles } from 'lucide-react';
import { useSiteContent } from '../content';
import type { Soundscape } from '../types';
import { useAmbientAudio } from './useAmbientAudio';

const FALLBACK_TRACK: Soundscape = {
  id: 'fallback-ambient',
  name: 'Ambient',
  description: '',
  type: 'synth',
  frequency: 110,
};

export default function MusicPlayer() {
  const { musicPlayer } = useSiteContent();
  const tracks = musicPlayer.tracks.length > 0 ? musicPlayer.tracks : [FALLBACK_TRACK];
  const [isOpen, setIsOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) || tracks[0];
  const [volume, setVolume] = useState(0.4);
  const [isMuted, setIsMuted] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const { audioError, prepareAudio, stopAudio } = useAmbientAudio({
    frequency: selectedTrack.frequency,
    isMuted,
    isPlaying,
    volume,
  });

  // Visualizer animation frame
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const playAttemptRef = useRef(0);

  const stopVisualizer = useCallback(() => {
    if (animFrameRef.current === null) return;
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
  }, []);

  // Toggle Play State
  const togglePlay = async () => {
    if (isPlaying) {
      playAttemptRef.current += 1;
      stopAudio();
      setIsPlaying(false);
      return;
    }

    const playAttempt = playAttemptRef.current + 1;
    playAttemptRef.current = playAttempt;
    if (await prepareAudio() && playAttemptRef.current === playAttempt) {
      setIsPlaying(true);
    }
  };

  const closePlayer = () => {
    playAttemptRef.current += 1;
    stopVisualizer();
    stopAudio();
    setIsPlaying(false);
    setIsOpen(false);
  };

  // Change Track
  const handleTrackChange = (track: Soundscape) => {
    setSelectedTrackId(track.id);
  };

  useEffect(() => {
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotionPreference = () => setPrefersReducedMotion(reducedMotionQuery.matches);
    const updateVisibility = () => setIsPageVisible(document.visibilityState === 'visible');
    updateMotionPreference();
    updateVisibility();
    reducedMotionQuery.addEventListener('change', updateMotionPreference);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      reducedMotionQuery.removeEventListener('change', updateMotionPreference);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  // Audio visualizer render loop (Pure CSS + dynamic canvas visualization)
  useEffect(() => {
    if (!isOpen || !isPlaying || !isPageVisible || prefersReducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = (canvas.width = 160);
    let height = (canvas.height = 40);

    const draw = (timestamp: number) => {
      ctx.clearRect(0, 0, width, height);

      const bars = 16;
      const barWidth = width / bars;

      for (let i = 0; i < bars; i++) {
        // Calculate artificial ambient height based on real playback state
        let barHeight = 2;
        const factor = Math.sin(timestamp * 0.003 + i * 0.5) * 0.5 + 0.5;
        const pulse = 0.85 + Math.sin(timestamp * 0.0017 + i) * 0.15;
        barHeight = Math.max(2, factor * (height - 4) * pulse * volume);

        const gradient = ctx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)'); // indigo
        gradient.addColorStop(0.5, 'rgba(168, 85, 247, 0.5)'); // purple
        gradient.addColorStop(1, 'rgba(236, 72, 153, 0.6)'); // pink

        ctx.fillStyle = gradient;
        // Rounded bar drawing
        ctx.beginPath();
        ctx.roundRect(i * barWidth + 1.5, height - barHeight, barWidth - 3, barHeight, 2);
        ctx.fill();
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);

    return stopVisualizer;
  }, [isOpen, isPageVisible, isPlaying, prefersReducedMotion, stopVisualizer, volume]);

  return (
    <div id="ambient-player-container" className="fixed bottom-4 sm:bottom-6 right-4 sm:right-6 z-50">
      <AnimatePresence mode="wait">
        {!isOpen ? (
          /* ==========================================
              MINIMIZED FLOATING ICON TRAY
             ========================================== */
          <motion.button
            key="minimized"
            id="expand-ambient-player"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            onClick={() => {
              setIsOpen(true);
            }}
            aria-label={musicPlayer.minimizedLabel}
            aria-pressed={isPlaying}
            className={`flex items-center justify-center w-12 h-12 rounded-full bg-zinc-950 border border-white/[0.08] hover:border-indigo-500/50 text-zinc-400 hover:text-white shadow-2xl transition-all cursor-pointer relative group ${
              isPlaying ? 'ring-2 ring-indigo-500/20' : ''
            }`}
          >
            {isPlaying ? (
              <span className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
            ) : null}
            <Music size={18} className={isPlaying ? 'animate-pulse text-indigo-400' : ''} />

            {/* Play state tooltip display */}
            <span className="absolute right-14 bg-zinc-950 border border-white/[0.05] text-[10px] px-2.5 py-1 rounded-md text-zinc-300 font-mono opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-lg">
              {isPlaying ? `${musicPlayer.playingPrefix} ${selectedTrack.name}` : musicPlayer.minimizedLabel}
            </span>
          </motion.button>
        ) : (
          /* ==========================================
              EXPANDED MUSIC PLAYER PANEL
             ========================================== */
          <motion.div
            key="expanded"
            initial={{ y: 20, scale: 0.95, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 20, scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            className="w-72 bg-zinc-950/95 border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md"
          >
            {/* Header Area */}
            <div className="bg-zinc-900/60 px-4 py-3 border-b border-white/[0.05] flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Radio size={14} className="text-indigo-400 animate-pulse" />
                <span className="text-[10px] font-mono text-zinc-400 font-semibold uppercase tracking-wider">{musicPlayer.title}</span>
              </div>
              <button
                id="minimize-ambient-player"
                onClick={closePlayer}
                aria-label="最小化环境音乐播放器"
                className="p-1 rounded hover:bg-white/[0.05] text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <Minimize2 size={13} />
              </button>
            </div>

            {/* Main Body */}
            <div className="p-4 space-y-4">
              {/* Audio Visualizer Stage */}
              <div className="bg-black/40 border border-white/[0.03] rounded-xl p-3 flex flex-col items-center justify-center min-h-[50px] relative overflow-hidden">
                <canvas ref={canvasRef} aria-hidden="true" className="opacity-90 relative z-10" />
                {!isPlaying && (
                  <span className="absolute text-[9px] font-mono text-zinc-600 uppercase tracking-widest select-none">
                    {musicPlayer.standbyLabel}
                  </span>
                )}
              </div>

              {/* Title & Description of Current Soundscape */}
              <div className="space-y-1">
                <div className="flex items-center space-x-1">
                  <Sparkles size={11} className="text-purple-400" />
                  <span className="text-xs font-bold text-white font-sans">{selectedTrack.name}</span>
                </div>
                <p className="text-[10px] text-zinc-400 leading-normal">
                  {selectedTrack.description}
                </p>
              </div>

              {/* Track Selection Buttons */}
              <div className="grid grid-cols-3 gap-1 bg-zinc-900/60 p-1 rounded-lg border border-white/[0.03]">
                {tracks.map((sc) => (
                  <button
                    key={sc.id}
                    onClick={() => handleTrackChange(sc)}
                    aria-pressed={selectedTrack.id === sc.id}
                    aria-label={`选择音轨：${sc.name}`}
                    className={`py-1.5 rounded-md text-[9px] font-mono font-medium capitalize transition-all cursor-pointer ${
                      selectedTrack.id === sc.id
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10'
                        : 'text-zinc-500 hover:text-white'
                    }`}
                  >
                    {sc.name.split(' ')[0]}
                  </button>
                ))}
              </div>

              {/* Playback Progress Indicator and Controls */}
              <div className="flex items-center justify-between gap-3 pt-2">
                {/* Play Button */}
                <button
                  id="toggle-ambient-play"
                  onClick={togglePlay}
                  aria-label={isPlaying ? '暂停环境音乐' : '播放环境音乐'}
                  aria-pressed={isPlaying}
                  className={`flex items-center justify-center w-10 h-10 rounded-full transition-all cursor-pointer ${
                    isPlaying
                      ? 'bg-zinc-900 hover:bg-zinc-800 border border-white/[0.05] text-white'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/15'
                  }`}
                >
                  {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                </button>

                {/* Volume & Mute Controls Slider */}
                <div className="flex-1 flex items-center space-x-2">
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    aria-label={isMuted ? '取消静音' : '静音'}
                    aria-pressed={isMuted}
                    className="text-zinc-500 hover:text-white transition-colors cursor-pointer"
                  >
                    {isMuted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      setVolume(parseFloat(e.target.value));
                      if (isMuted) setIsMuted(false);
                    }}
                    aria-label="环境音乐音量"
                    className="w-full accent-indigo-500 bg-zinc-800 h-1 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
              </div>
              {audioError ? (
                <p role="status" className="text-[10px] leading-relaxed text-amber-300">
                  {audioError}
                </p>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
