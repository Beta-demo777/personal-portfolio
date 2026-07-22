import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MusicPlayer from './MusicPlayer';

let activeConnections = 0;
let activeSources = 0;
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);

function audioParam() {
  return {
    linearRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };
}

function audioNode(extra: Record<string, unknown> = {}) {
  let connections = 0;
  return {
    connect: vi.fn(() => {
      connections += 1;
      activeConnections += 1;
    }),
    disconnect: vi.fn(() => {
      activeConnections -= connections;
      connections = 0;
    }),
    ...extra,
  };
}

class FakeAudioContext {
  currentTime = 0;
  destination = audioNode();
  state: AudioContextState = 'running';
  close = vi.fn(async () => { this.state = 'closed'; });
  resume = vi.fn(async () => { this.state = 'running'; });

  createGain() {
    return audioNode({ gain: audioParam() }) as unknown as GainNode;
  }

  createBiquadFilter() {
    return audioNode({ frequency: audioParam(), type: 'lowpass' }) as unknown as BiquadFilterNode;
  }

  createOscillator() {
    let running = false;
    return audioNode({
      frequency: audioParam(),
      start: vi.fn(() => {
        if (running) return;
        running = true;
        activeSources += 1;
      }),
      stop: vi.fn(() => {
        if (!running) return;
        running = false;
        activeSources -= 1;
      }),
      type: 'sine',
    }) as unknown as OscillatorNode;
  }
}

describe('MusicPlayer resource lifecycle', () => {
  let nextFrameId: number;
  let visualizerFrames: Set<number>;

  beforeEach(() => {
    activeConnections = 0;
    activeSources = 0;
    nextFrameId = 1;
    visualizerFrames = new Set();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fill: vi.fn(),
      fillStyle: '',
      roundRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      if (callback.name !== 'draw') return nativeRequestAnimationFrame(callback);
      const frameId = 1_000_000 + nextFrameId;
      nextFrameId += 1;
      visualizerFrames.add(frameId);
      return frameId;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frameId: number) => {
      if (!visualizerFrames.delete(frameId)) nativeCancelAnimationFrame(frameId);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops every audio node and visualizer frame when the player is minimized', async () => {
    const user = userEvent.setup();
    render(<MusicPlayer />);

    await user.click(screen.getByRole('button', { name: 'Ambient Synth Engine' }));
    await user.click(await screen.findByRole('button', { name: '播放环境音乐' }));

    await waitFor(() => {
      expect(activeSources).toBe(5);
      expect(activeConnections).toBeGreaterThan(0);
      expect(visualizerFrames.size).toBe(1);
    });

    await user.click(screen.getByRole('button', { name: '最小化环境音乐播放器' }));

    await waitFor(() => {
      expect(activeSources).toBe(0);
      expect(activeConnections).toBe(0);
      expect(visualizerFrames.size).toBe(0);
    });
  });
});
