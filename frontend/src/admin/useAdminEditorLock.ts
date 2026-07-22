import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimAdminDraftLease,
  type AdminDraftLease,
} from './draftStorage';

export type AdminEditorLockStatus = 'idle' | 'acquiring' | 'held' | 'contended' | 'unavailable';

export interface AdminEditorLock {
  status: AdminEditorLockStatus;
  lease: AdminDraftLease | null;
  isCurrentLease(lease: AdminDraftLease | null): lease is AdminDraftLease;
  rotateLease(): Promise<AdminDraftLease | null>;
  release(): void;
}

const ADMIN_EDITOR_LOCK_NAME = 'portfolio-admin-content-editor';
const LOCK_RETRY_INTERVAL_MS = 2_000;

function createOwnerId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `admin-editor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sameLease(left: AdminDraftLease | null, right: AdminDraftLease | null): boolean {
  return left !== null
    && right !== null
    && left.ownerId === right.ownerId
    && left.generation === right.generation;
}

export function useAdminEditorLock(active: boolean): AdminEditorLock {
  const [state, setState] = useState<Pick<AdminEditorLock, 'status' | 'lease'>>({
    status: 'idle',
    lease: null,
  });
  const ownerIdRef = useRef(createOwnerId());
  const generationRef = useRef(0);
  const activeLeaseRef = useRef<AdminDraftLease | null>(null);
  const releaseHeldLockRef = useRef<(() => void) | null>(null);
  const holdingWebLockRef = useRef(false);

  const release = useCallback(() => {
    activeLeaseRef.current = null;
    const releaseHeldLock = releaseHeldLockRef.current;
    releaseHeldLockRef.current = null;
    releaseHeldLock?.();
    setState({ status: 'idle', lease: null });
  }, []);

  const isCurrentLease = useCallback((lease: AdminDraftLease | null): lease is AdminDraftLease => (
    sameLease(activeLeaseRef.current, lease)
  ), []);

  const rotateLease = useCallback(async (): Promise<AdminDraftLease | null> => {
    if (!activeLeaseRef.current || !holdingWebLockRef.current) return null;
    activeLeaseRef.current = null;
    setState({ status: 'acquiring', lease: null });
    const lease: AdminDraftLease = {
      ownerId: ownerIdRef.current,
      generation: generationRef.current + 1,
    };
    generationRef.current = lease.generation;
    const claimed = await claimAdminDraftLease(lease);
    if (!claimed.ok || !holdingWebLockRef.current) {
      setState({ status: 'unavailable', lease: null });
      return null;
    }
    activeLeaseRef.current = lease;
    setState({ status: 'held', lease });
    return lease;
  }, []);

  useEffect(() => {
    if (!active) {
      release();
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.locks) {
      setState({ status: 'unavailable', lease: null });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let finishRetryWait: (() => void) | null = null;

    const waitBeforeRetry = () => new Promise<void>((resolve) => {
      const finish = () => {
        if (finishRetryWait !== finish) return;
        finishRetryWait = null;
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        resolve();
      };
      finishRetryWait = finish;
      retryTimer = window.setTimeout(finish, LOCK_RETRY_INTERVAL_MS);
    });

    const acquire = async () => {
      setState({ status: 'acquiring', lease: null });
      try {
        while (!cancelled) {
          let acquired = false;
          await navigator.locks.request(
            ADMIN_EDITOR_LOCK_NAME,
            { mode: 'exclusive', ifAvailable: true },
            async (lock) => {
              if (!lock || cancelled) return;
              acquired = true;
              holdingWebLockRef.current = true;
              const lease: AdminDraftLease = {
                ownerId: ownerIdRef.current,
                generation: generationRef.current + 1,
              };
              generationRef.current = lease.generation;
              const claimed = await claimAdminDraftLease(lease);
              if (!claimed.ok || cancelled) {
                if (!cancelled) setState({ status: 'unavailable', lease: null });
                holdingWebLockRef.current = false;
                return;
              }
              activeLeaseRef.current = lease;
              setState({ status: 'held', lease });
              await new Promise<void>((resolve) => {
                releaseHeldLockRef.current = resolve;
              });
              if (sameLease(activeLeaseRef.current, lease)) {
                activeLeaseRef.current = null;
                setState({ status: 'idle', lease: null });
              }
              releaseHeldLockRef.current = null;
              holdingWebLockRef.current = false;
            },
          );
          if (cancelled || acquired) return;
          setState({ status: 'contended', lease: null });
          await waitBeforeRetry();
        }
      } catch {
        if (!cancelled) setState({ status: 'unavailable', lease: null });
      }
    };

    void acquire();
    return () => {
      cancelled = true;
      finishRetryWait?.();
      release();
    };
  }, [active, release]);

  return {
    ...state,
    isCurrentLease,
    rotateLease,
    release,
  };
}
