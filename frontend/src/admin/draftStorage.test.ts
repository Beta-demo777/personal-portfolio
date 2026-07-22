import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_CONTENT } from '../content';
import {
  ADMIN_DRAFT_SCHEMA_VERSION,
  AdminDraftStorageError,
  createAdminDraftStorage,
  createLocalStorageLegacyAdminDraftAdapter,
  type AdminDraft,
  type AdminDraftLease,
  type AdminDraftPersistenceAdapter,
  type CurrentAdminDraft,
  type LegacyAdminDraftAdapter,
} from './draftStorage';

const TEST_LEASE: AdminDraftLease = {
  ownerId: 'unit-test-owner',
  generation: 1,
};

function sameLease(left: AdminDraftLease | null, right: AdminDraftLease): boolean {
  return left?.ownerId === right.ownerId && left.generation === right.generation;
}

function currentDraft(): CurrentAdminDraft {
  return {
    kind: 'current',
    schemaVersion: ADMIN_DRAFT_SCHEMA_VERSION,
    baseEtag: '"content-v7"',
    baseContent: structuredClone(DEFAULT_SITE_CONTENT),
    content: structuredClone(DEFAULT_SITE_CONTENT),
    savedAt: '2026-07-17T08:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function adapters(initial: unknown | null = null) {
  let persisted = initial;
  let legacy: unknown | null = null;
  let lease: AdminDraftLease | null = TEST_LEASE;
  const draftAdapter: AdminDraftPersistenceAdapter = {
    read: vi.fn(async () => persisted),
    claimLease: vi.fn(async (nextLease) => {
      lease = nextLease;
    }),
    isLeaseCurrent: vi.fn(async (candidate) => sameLease(lease, candidate)),
    write: vi.fn(async (record: AdminDraft, candidate: AdminDraftLease) => {
      if (!sameLease(lease, candidate)) return false;
      persisted = record;
      return true;
    }),
    remove: vi.fn(async (candidate) => {
      if (!sameLease(lease, candidate)) return false;
      persisted = null;
      return true;
    }),
  };
  const legacyAdapter: LegacyAdminDraftAdapter = {
    read: vi.fn(async () => legacy),
    remove: vi.fn(async () => {
      legacy = null;
    }),
  };

  return {
    draftAdapter,
    legacyAdapter,
    setLegacy(value: unknown | null) {
      legacy = value;
    },
    getPersisted() {
      return persisted;
    },
    getLegacy() {
      return legacy;
    },
    getLease() {
      return lease;
    },
  };
}

describe('admin draft storage', () => {
  it('writes and reads a fully versioned current draft', async () => {
    const backend = adapters();
    const storage = createAdminDraftStorage(backend);
    const draft = currentDraft();
    draft.content.siteSettings.siteTitle = 'An unsaved title';

    await expect(storage.write(draft, TEST_LEASE)).resolves.toEqual({ ok: true, value: undefined });
    await expect(storage.read()).resolves.toEqual({ ok: true, value: draft });
  });

  it('serializes writes so an older slow write cannot overwrite a newer draft', async () => {
    let persisted: AdminDraft | null = null;
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const started: string[] = [];
    const draftAdapter: AdminDraftPersistenceAdapter = {
      read: vi.fn(async () => persisted),
      claimLease: vi.fn(async () => undefined),
      isLeaseCurrent: vi.fn(async (candidate) => sameLease(TEST_LEASE, candidate)),
      write: vi.fn(async (record, candidate) => {
        if (!sameLease(TEST_LEASE, candidate)) return false;
        started.push(record.savedAt);
        await (started.length === 1 ? firstWrite.promise : secondWrite.promise);
        persisted = record;
        return true;
      }),
      remove: vi.fn(async (candidate) => {
        if (!sameLease(TEST_LEASE, candidate)) return false;
        persisted = null;
        return true;
      }),
    };
    const legacyAdapter: LegacyAdminDraftAdapter = {
      read: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
    };
    const storage = createAdminDraftStorage({ draftAdapter, legacyAdapter });
    const older = currentDraft();
    const newer = currentDraft();
    newer.savedAt = '2026-07-17T08:01:00.000Z';
    newer.content.siteSettings.siteTitle = 'Newest title';

    const olderResult = storage.write(older, TEST_LEASE);
    const newerResult = storage.write(newer, TEST_LEASE);
    await Promise.resolve();

    expect(started).toEqual([older.savedAt]);
    firstWrite.resolve();
    await olderResult;
    await Promise.resolve();
    expect(started).toEqual([older.savedAt, newer.savedAt]);

    secondWrite.resolve();
    await newerResult;
    expect(persisted).toBe(newer);
  });

  it('orders removal after an in-flight write', async () => {
    let persisted: AdminDraft | null = null;
    const writeGate = deferred<void>();
    const events: string[] = [];
    const draftAdapter: AdminDraftPersistenceAdapter = {
      read: vi.fn(async () => persisted),
      claimLease: vi.fn(async () => undefined),
      isLeaseCurrent: vi.fn(async (candidate) => sameLease(TEST_LEASE, candidate)),
      write: vi.fn(async (record, candidate) => {
        if (!sameLease(TEST_LEASE, candidate)) return false;
        events.push('write-start');
        await writeGate.promise;
        persisted = record;
        events.push('write-end');
        return true;
      }),
      remove: vi.fn(async (candidate) => {
        if (!sameLease(TEST_LEASE, candidate)) return false;
        events.push('remove');
        persisted = null;
        return true;
      }),
    };
    const legacyAdapter: LegacyAdminDraftAdapter = {
      read: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
    };
    const storage = createAdminDraftStorage({ draftAdapter, legacyAdapter });

    const writeResult = storage.write(currentDraft(), TEST_LEASE);
    const removeResult = storage.remove(TEST_LEASE);
    await Promise.resolve();
    expect(events).toEqual(['write-start']);

    writeGate.resolve();
    await writeResult;
    await removeResult;
    expect(events).toEqual(['write-start', 'write-end', 'remove']);
    expect(persisted).toBeNull();
  });

  it.each([
    ['empty ETag', (draft: CurrentAdminDraft) => { draft.baseEtag = '  '; }],
    ['incomplete base content', (draft: CurrentAdminDraft) => {
      delete (draft.baseContent as Partial<typeof draft.baseContent>).siteSettings;
    }],
    ['incomplete edited content', (draft: CurrentAdminDraft) => {
      delete (draft.content as Partial<typeof draft.content>).blogPosts;
    }],
    ['invalid timestamp', (draft: CurrentAdminDraft) => { draft.savedAt = 'not-a-date'; }],
  ])('rejects current records with %s before writing', async (_label, mutate) => {
    const backend = adapters();
    const storage = createAdminDraftStorage(backend);
    const draft = currentDraft();
    mutate(draft);

    await expect(storage.write(draft, TEST_LEASE)).resolves.toEqual({ ok: false, code: 'invalid-data' });
    expect(backend.draftAdapter.write).not.toHaveBeenCalled();
  });

  it('falls back to a valid legacy draft and identifies only the invalid IndexedDB source', async () => {
    const backend = adapters({
      ...currentDraft(),
      baseContent: { siteSettings: {} },
    });
    const legacy = {
      content: structuredClone(DEFAULT_SITE_CONTENT),
      savedAt: '2026-07-17T08:00:00.000Z',
    };
    legacy.content.siteSettings.siteTitle = 'Valid legacy safety copy';
    backend.setLegacy(legacy);
    const storage = createAdminDraftStorage(backend);

    const result = await storage.read();

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: 'legacy',
        content: { siteSettings: { siteTitle: 'Valid legacy safety copy' } },
      },
      invalidSources: ['indexeddb'],
    });
    expect(backend.legacyAdapter.read).toHaveBeenCalledOnce();
    if (!result.ok) throw new Error('Expected a valid legacy fallback');
    await expect(storage.removeSources(result.invalidSources ?? [], TEST_LEASE))
      .resolves.toEqual({ ok: true, value: undefined });
    expect(backend.getPersisted()).toBeNull();
    expect(backend.getLegacy()).toBe(legacy);
    expect(backend.legacyAdapter.remove).not.toHaveBeenCalled();
  });

  it('preserves an unsupported future-version IndexedDB record and fails closed', async () => {
    const futureDraft = {
      ...currentDraft(),
      schemaVersion: ADMIN_DRAFT_SCHEMA_VERSION + 1,
    };
    const backend = adapters(futureDraft);
    backend.setLegacy({
      content: structuredClone(DEFAULT_SITE_CONTENT),
      savedAt: '2026-07-17T08:00:00.000Z',
    });
    const storage = createAdminDraftStorage(backend);

    await expect(storage.read()).resolves.toEqual({
      ok: false,
      code: 'unsupported-version',
      source: 'indexeddb',
    });
    expect(backend.getPersisted()).toBe(futureDraft);
    expect(backend.legacyAdapter.read).not.toHaveBeenCalled();
    expect(backend.draftAdapter.remove).not.toHaveBeenCalled();
    expect(backend.legacyAdapter.remove).not.toHaveBeenCalled();
  });

  it('recognizes localStorage v1 as legacy without inventing a merge base', async () => {
    const backend = adapters();
    backend.setLegacy({
      content: structuredClone(DEFAULT_SITE_CONTENT),
      savedAt: '2026-07-17T08:00:00.000Z',
    });
    const storage = createAdminDraftStorage(backend);

    const result = await storage.read();

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) throw new Error('Expected a legacy draft');
    expect(result.value).toMatchObject({ kind: 'legacy', schemaVersion: 1 });
    expect(result.value).not.toHaveProperty('baseEtag');
    expect(result.value).not.toHaveProperty('baseContent');
    expect(backend.draftAdapter.write).not.toHaveBeenCalled();
  });

  it('rejects a legacy-looking record that claims to have a server base', async () => {
    const backend = adapters();
    backend.setLegacy({
      content: DEFAULT_SITE_CONTENT,
      savedAt: '2026-07-17T08:00:00.000Z',
      baseEtag: '"untrusted"',
      baseContent: DEFAULT_SITE_CONTENT,
    });
    const storage = createAdminDraftStorage(backend);

    await expect(storage.read()).resolves.toEqual({
      ok: false,
      code: 'invalid-data',
      source: 'legacy-local-storage',
      invalidSources: ['legacy-local-storage'],
    });
  });

  it('migrates legacy data explicitly and preserves its legacy shape and source', async () => {
    const backend = adapters();
    const rawLegacy = {
      content: structuredClone(DEFAULT_SITE_CONTENT),
      savedAt: '2026-07-17T08:00:00.000Z',
    };
    backend.setLegacy(rawLegacy);
    const storage = createAdminDraftStorage(backend);

    const result = await storage.migrateLegacy(TEST_LEASE);

    expect(result).toMatchObject({ ok: true, value: { status: 'migrated' } });
    expect(backend.getPersisted()).toMatchObject({
      kind: 'legacy',
      schemaVersion: 1,
      content: rawLegacy.content,
      savedAt: rawLegacy.savedAt,
    });
    expect(backend.getPersisted()).not.toHaveProperty('baseEtag');
    expect(backend.getLegacy()).toBe(rawLegacy);
    expect(backend.legacyAdapter.remove).not.toHaveBeenCalled();
  });

  it('does not overwrite an IndexedDB record during explicit legacy migration', async () => {
    const existing = currentDraft();
    const backend = adapters(existing);
    backend.setLegacy({ content: DEFAULT_SITE_CONTENT, savedAt: '2026-07-17T08:00:00.000Z' });
    const storage = createAdminDraftStorage(backend);

    await expect(storage.migrateLegacy(TEST_LEASE)).resolves.toEqual({
      ok: true,
      value: { status: 'target-exists', draft: existing },
    });
    expect(backend.draftAdapter.write).not.toHaveBeenCalled();
  });

  it('keeps cleanup separate from migration', async () => {
    const backend = adapters();
    backend.setLegacy({ content: DEFAULT_SITE_CONTENT, savedAt: '2026-07-17T08:00:00.000Z' });
    const storage = createAdminDraftStorage(backend);

    await storage.migrateLegacy(TEST_LEASE);
    expect(backend.getLegacy()).not.toBeNull();

    await expect(storage.removeLegacy(TEST_LEASE)).resolves.toEqual({ ok: true, value: undefined });
    expect(backend.getLegacy()).toBeNull();
  });

  it('removes only the IndexedDB draft and preserves a legacy safety copy', async () => {
    const backend = adapters(currentDraft());
    const legacy = {
      content: structuredClone(DEFAULT_SITE_CONTENT),
      savedAt: '2026-07-17T08:00:00.000Z',
    };
    legacy.content.siteSettings.siteTitle = 'Uninspected legacy safety copy';
    backend.setLegacy(legacy);
    const storage = createAdminDraftStorage(backend);

    await expect(storage.remove(TEST_LEASE)).resolves.toEqual({ ok: true, value: undefined });
    expect(backend.draftAdapter.remove).toHaveBeenCalledOnce();
    expect(backend.legacyAdapter.remove).not.toHaveBeenCalled();
    expect(backend.getPersisted()).toBeNull();
    expect(backend.getLegacy()).toBe(legacy);
  });

  it('reports an explicit legacy cleanup failure without touching IndexedDB', async () => {
    const existing = currentDraft();
    const backend = adapters(existing);
    backend.setLegacy({
      content: structuredClone(DEFAULT_SITE_CONTENT),
      savedAt: '2026-07-17T08:00:00.000Z',
    });
    backend.legacyAdapter.remove = vi.fn(async () => {
      throw new Error('localStorage removal failed');
    });
    const storage = createAdminDraftStorage(backend);

    await expect(storage.removeLegacy(TEST_LEASE)).resolves.toEqual({ ok: false, code: 'delete-failed' });
    expect(backend.draftAdapter.remove).not.toHaveBeenCalled();
    expect(backend.legacyAdapter.remove).toHaveBeenCalledOnce();
    expect(backend.getPersisted()).toBe(existing);
  });

  it.each([
    ['unavailable', new AdminDraftStorageError('unavailable'), 'unavailable'],
    ['security', new DOMException('denied', 'SecurityError'), 'security'],
    ['read failure', new Error('read failed'), 'read-failed'],
  ] as const)('classifies %s read errors', async (_label, error, expectedCode) => {
    const backend = adapters();
    backend.draftAdapter.read = vi.fn(async () => {
      throw error;
    });
    const storage = createAdminDraftStorage(backend);

    await expect(storage.read()).resolves.toEqual({
      ok: false,
      code: expectedCode,
      source: 'indexeddb',
    });
  });

  it('classifies quota and generic write errors', async () => {
    const quotaBackend = adapters();
    quotaBackend.draftAdapter.write = vi.fn(async () => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const writeBackend = adapters();
    writeBackend.draftAdapter.write = vi.fn(async () => {
      throw new Error('write failed');
    });

    await expect(createAdminDraftStorage(quotaBackend).write(currentDraft(), TEST_LEASE))
      .resolves.toEqual({ ok: false, code: 'quota-exceeded' });
    await expect(createAdminDraftStorage(writeBackend).write(currentDraft(), TEST_LEASE))
      .resolves.toEqual({ ok: false, code: 'write-failed' });
  });

  it('reports invalid legacy JSON without adding an IndexedDB test dependency', async () => {
    const backend = adapters();
    const legacyAdapter = createLocalStorageLegacyAdminDraftAdapter({
      storage: {
        getItem: vi.fn(() => '{invalid json'),
        removeItem: vi.fn(),
      },
    });
    const storage = createAdminDraftStorage({
      draftAdapter: backend.draftAdapter,
      legacyAdapter,
    });

    await expect(storage.read()).resolves.toEqual({
      ok: false,
      code: 'invalid-data',
      source: 'legacy-local-storage',
      invalidSources: ['legacy-local-storage'],
    });
  });

  it('rejects writes and removals from an owner whose lease was replaced', async () => {
    const backend = adapters(currentDraft());
    const storage = createAdminDraftStorage(backend);
    const nextLease: AdminDraftLease = {
      ownerId: 'second-tab',
      generation: 1,
    };
    const secondTabDraft = currentDraft();
    secondTabDraft.content.siteSettings.siteTitle = 'Second tab draft';

    await expect(storage.claimLease(nextLease)).resolves.toEqual({ ok: true, value: undefined });
    await expect(storage.write(secondTabDraft, nextLease)).resolves.toEqual({ ok: true, value: undefined });

    const staleDraft = currentDraft();
    staleDraft.content.siteSettings.siteTitle = 'Late first-tab draft';
    await expect(storage.write(staleDraft, TEST_LEASE))
      .resolves.toEqual({ ok: false, code: 'stale-owner' });
    await expect(storage.remove(TEST_LEASE))
      .resolves.toEqual({ ok: false, code: 'stale-owner' });
    expect(backend.getPersisted()).toEqual(secondTabDraft);
  });
});
