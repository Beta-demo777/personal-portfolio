import { useCallback, useEffect, useRef, useState } from 'react';

interface AmbientAudioOptions {
  frequency: number;
  isMuted: boolean;
  isPlaying: boolean;
  volume: number;
}

interface AudioGraph {
  filter: BiquadFilterNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  mainGain: GainNode;
  noteGains: GainNode[];
  oscillators: OscillatorNode[];
}

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const audioWindow = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return audioWindow.AudioContext || audioWindow.webkitAudioContext;
}

function stopGraph(graph: AudioGraph): void {
  for (const oscillator of graph.oscillators) {
    try {
      oscillator.stop();
    } catch {
      // The node may already have stopped during browser teardown.
    }
    oscillator.disconnect();
  }
  try {
    graph.lfo.stop();
  } catch {
    // The node may already have stopped during browser teardown.
  }
  graph.lfo.disconnect();
  graph.lfoGain.disconnect();
  for (const gain of graph.noteGains) gain.disconnect();
  graph.filter.disconnect();
  graph.mainGain.disconnect();
}

function createGraph(context: AudioContext, frequency: number, outputGain: number): AudioGraph {
  const mainGain = context.createGain();
  mainGain.gain.setValueAtTime(outputGain, context.currentTime);

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(350, context.currentTime);
  filter.connect(mainGain);
  mainGain.connect(context.destination);

  const chordRatios = [1, 1.25, 1.5, 1.875];
  const oscillators: OscillatorNode[] = [];
  const noteGains: GainNode[] = [];
  for (const [index, ratio] of chordRatios.entries()) {
    const oscillator = context.createOscillator();
    oscillator.type = index === 0 ? 'sine' : 'triangle';
    oscillator.frequency.setValueAtTime(frequency * ratio, context.currentTime);

    const noteGain = context.createGain();
    noteGain.gain.setValueAtTime(0.08 / chordRatios.length, context.currentTime);
    oscillator.connect(noteGain);
    noteGain.connect(filter);
    oscillator.start();
    oscillators.push(oscillator);
    noteGains.push(noteGain);
  }

  const lfo = context.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(0.15, context.currentTime);
  const lfoGain = context.createGain();
  lfoGain.gain.setValueAtTime(150, context.currentTime);
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);
  lfo.start();

  return { filter, lfo, lfoGain, mainGain, noteGains, oscillators };
}

export function useAmbientAudio({
  frequency,
  isMuted,
  isPlaying,
  volume,
}: AmbientAudioOptions) {
  const contextRef = useRef<AudioContext | null>(null);
  const graphRef = useRef<AudioGraph | null>(null);
  const outputGainRef = useRef(isMuted ? 0 : volume);
  const [audioError, setAudioError] = useState<string | null>(null);
  outputGainRef.current = isMuted ? 0 : volume;

  const stopAudio = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graphRef.current = null;
    stopGraph(graph);
  }, []);

  const prepareAudio = useCallback(async (): Promise<boolean> => {
    try {
      if (!contextRef.current) {
        const AudioContextClass = audioContextConstructor();
        if (!AudioContextClass) {
          setAudioError('当前浏览器不支持环境音频播放。');
          return false;
        }
        contextRef.current = new AudioContextClass();
      }
      if (contextRef.current.state === 'suspended') {
        await contextRef.current.resume();
      }
      setAudioError(null);
      return contextRef.current.state === 'running';
    } catch {
      setAudioError('音频无法启动，请检查浏览器的自动播放设置。');
      return false;
    }
  }, []);

  useEffect(() => {
    const context = contextRef.current;
    if (!isPlaying || !context || context.state === 'closed') return;

    try {
      const graph = createGraph(context, frequency, outputGainRef.current);
      graphRef.current = graph;
      return () => {
        if (graphRef.current === graph) stopAudio();
      };
    } catch {
      setAudioError('当前音轨无法播放，请选择其他音轨重试。');
    }
  }, [frequency, isPlaying, stopAudio]);

  useEffect(() => {
    const context = contextRef.current;
    const graph = graphRef.current;
    if (!context || !graph || context.state === 'closed') return;
    graph.mainGain.gain.linearRampToValueAtTime(
      isMuted ? 0 : volume,
      context.currentTime + 0.1,
    );
  }, [isMuted, volume]);

  useEffect(() => () => {
    stopAudio();
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== 'closed') void context.close();
  }, [stopAudio]);

  return { audioError, prepareAudio, stopAudio };
}
