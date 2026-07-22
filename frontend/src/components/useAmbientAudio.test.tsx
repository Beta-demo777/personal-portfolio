import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAmbientAudio } from './useAmbientAudio';

function audioParam() {
  return {
    linearRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };
}

function audioNode(extra: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    ...extra,
  };
}

type FakeOscillatorNode = ReturnType<typeof audioNode> & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  destination = audioNode();
  state: AudioContextState = 'running';
  close = vi.fn(async () => { this.state = 'closed'; });
  resume = vi.fn(async () => { this.state = 'running'; });
  gains: ReturnType<typeof audioNode>[] = [];
  filters: ReturnType<typeof audioNode>[] = [];
  oscillators: FakeOscillatorNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = audioNode({ gain: audioParam() });
    this.gains.push(node);
    return node as unknown as GainNode;
  }

  createBiquadFilter() {
    const node = audioNode({ frequency: audioParam(), type: 'lowpass' });
    this.filters.push(node);
    return node as unknown as BiquadFilterNode;
  }

  createOscillator() {
    const node = audioNode({
      frequency: audioParam(),
      start: vi.fn(),
      stop: vi.fn(),
      type: 'sine',
    }) as FakeOscillatorNode;
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }
}

describe('useAmbientAudio', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
  });

  it('stops the previous graph on track changes and closes the context on unmount', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ frequency, isPlaying }) => useAmbientAudio({
        frequency,
        isMuted: false,
        isPlaying,
        volume: 0.4,
      }),
      { initialProps: { frequency: 110, isPlaying: false } },
    );

    await act(async () => {
      expect(await result.current.prepareAudio()).toBe(true);
    });
    rerender({ frequency: 110, isPlaying: true });

    const context = FakeAudioContext.instances[0];
    const firstGraph = context.oscillators.slice();
    expect(firstGraph).toHaveLength(5);
    expect(firstGraph.every((node) => vi.mocked(node.start as () => void).mock.calls.length === 1)).toBe(true);

    rerender({ frequency: 220, isPlaying: true });
    expect(firstGraph.every((node) => vi.mocked(node.stop as () => void).mock.calls.length === 1)).toBe(true);
    expect(firstGraph.every((node) => vi.mocked(node.disconnect as () => void).mock.calls.length === 1)).toBe(true);
    expect(context.oscillators).toHaveLength(10);

    const activeGraph = context.oscillators.slice(5);
    unmount();
    expect(activeGraph.every((node) => vi.mocked(node.stop as () => void).mock.calls.length === 1)).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('does not create a graph before a user gesture prepares audio', () => {
    const { unmount } = renderHook(() => useAmbientAudio({
      frequency: 110,
      isMuted: false,
      isPlaying: true,
      volume: 0.4,
    }));

    expect(FakeAudioContext.instances).toHaveLength(0);
    unmount();
  });
});
