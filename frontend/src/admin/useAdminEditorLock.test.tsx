import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAdminDraftLease } from './draftStorage';
import { useAdminEditorLock } from './useAdminEditorLock';

vi.mock('./draftStorage', async (importOriginal) => {
  const original = await importOriginal<typeof import('./draftStorage')>();
  return {
    ...original,
    claimAdminDraftLease: vi.fn(),
  };
});

const claimLeaseMock = vi.mocked(claimAdminDraftLease);

describe('useAdminEditorLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimLeaseMock.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(async (
          _name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => Promise<void>,
        ) => callback({ name: 'portfolio-admin-content-editor', mode: 'exclusive' } as Lock)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('publishes a held lease only after claiming its durable generation', async () => {
    const { result, unmount } = renderHook(() => useAdminEditorLock(true));

    await waitFor(() => expect(result.current.status).toBe('held'));

    expect(claimLeaseMock).toHaveBeenCalledOnce();
    expect(result.current.lease).toMatchObject({ generation: 1 });
    expect(result.current.isCurrentLease(result.current.lease)).toBe(true);
    unmount();
  });

  it('invalidates the old generation synchronously while rotating the durable lease', async () => {
    const { result, unmount } = renderHook(() => useAdminEditorLock(true));
    await waitFor(() => expect(result.current.status).toBe('held'));
    const firstLease = result.current.lease;

    let rotation!: Promise<unknown>;
    act(() => {
      rotation = result.current.rotateLease();
    });
    expect(result.current.isCurrentLease(firstLease)).toBe(false);

    await act(async () => {
      await rotation;
    });
    expect(result.current.status).toBe('held');
    expect(result.current.lease).toMatchObject({
      ownerId: firstLease?.ownerId,
      generation: 2,
    });
    expect(claimLeaseMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('fails closed when the durable lease marker cannot be claimed', async () => {
    claimLeaseMock.mockResolvedValueOnce({ ok: false, code: 'write-failed' });
    const { result } = renderHook(() => useAdminEditorLock(true));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));

    expect(result.current.lease).toBeNull();
  });

  it('settles a pending retry wait when active becomes false', async () => {
    const requestMock = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ) => callback(null));
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: requestMock },
    });

    const NativePromise = globalThis.Promise;
    const nativeSetTimeout = window.setTimeout.bind(window);
    let currentConstruction: { schedulesRetry: boolean } | null = null;
    const retryWaitRef: { current: Promise<void> | null } = { current: null };
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 2_000 && currentConstruction) {
        currentConstruction.schedulesRetry = true;
        return 1;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);

    class TrackingPromise<T> extends NativePromise<T> {
      constructor(executor: (
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason?: unknown) => void,
      ) => void) {
        const construction = { schedulesRetry: false };
        const previousConstruction = currentConstruction;
        currentConstruction = construction;
        super(executor);
        currentConstruction = previousConstruction;
        if (construction.schedulesRetry) retryWaitRef.current = this as Promise<void>;
      }
    }
    vi.stubGlobal('Promise', TrackingPromise);

    const { result, rerender, unmount } = renderHook(
      ({ active }) => useAdminEditorLock(active),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(result.current.status).toBe('contended'));
    expect(requestMock).toHaveBeenCalledOnce();
    expect(retryWaitRef.current).not.toBeNull();

    vi.unstubAllGlobals();
    setTimeoutSpy.mockRestore();
    let retrySettled = false;
    retryWaitRef.current?.then(() => {
      retrySettled = true;
    });

    await act(async () => {
      rerender({ active: false });
      await NativePromise.resolve();
    });

    expect(result.current.status).toBe('idle');
    expect(retrySettled).toBe(true);
    expect(requestMock).toHaveBeenCalledOnce();
    unmount();
  });
});
