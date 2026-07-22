import type { SiteContent } from '../content';
import { isSiteContent } from '../contentValidation';

export const ADMIN_DRAFT_SCHEMA_VERSION = 2 as const;
export const LEGACY_ADMIN_DRAFT_SCHEMA_VERSION = 1 as const;
export const ADMIN_DRAFT_DATABASE_NAME = 'portfolio-admin-drafts';
export const ADMIN_DRAFT_OBJECT_STORE_NAME = 'drafts';
export const ADMIN_DRAFT_RECORD_KEY = 'site-content';
export const ADMIN_DRAFT_LEASE_RECORD_KEY = 'site-content-lease';
export const LEGACY_ADMIN_DRAFT_STORAGE_KEY = 'portfolio-cms-autobackup-v1';

export interface CurrentAdminDraft {
  kind: 'current';
  schemaVersion: typeof ADMIN_DRAFT_SCHEMA_VERSION;
  baseEtag: string;
  baseContent: SiteContent;
  content: SiteContent;
  savedAt: string;
}

/**
 * A v1 draft has no trustworthy server base. Keep it as a separate type so it
 * cannot accidentally enter the three-way merge path as a current draft.
 */
export interface LegacyAdminDraft {
  kind: 'legacy';
  schemaVersion: typeof LEGACY_ADMIN_DRAFT_SCHEMA_VERSION;
  content: SiteContent;
  savedAt: string;
}

export type AdminDraft = CurrentAdminDraft | LegacyAdminDraft;

export interface AdminDraftLease {
  ownerId: string;
  generation: number;
}

export type AdminDraftSource = 'indexeddb' | 'legacy-local-storage';

export type AdminDraftFailureCode =
  | 'unavailable'
  | 'security'
  | 'quota-exceeded'
  | 'read-failed'
  | 'write-failed'
  | 'delete-failed'
  | 'invalid-data'
  | 'unsupported-version'
  | 'stale-owner';

export type AdminDraftResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AdminDraftFailureCode };

export type AdminDraftReadResult<T> =
  | { ok: true; value: T; invalidSources?: AdminDraftSource[] }
  | {
    ok: false;
    code: AdminDraftFailureCode;
    source: AdminDraftSource;
    invalidSources?: AdminDraftSource[];
  };

export interface AdminDraftPersistenceAdapter {
  read(): Promise<unknown | null>;
  claimLease(lease: AdminDraftLease): Promise<void>;
  isLeaseCurrent(lease: AdminDraftLease): Promise<boolean>;
  write(record: AdminDraft, lease: AdminDraftLease): Promise<boolean>;
  remove(lease: AdminDraftLease): Promise<boolean>;
}

export interface LegacyAdminDraftAdapter {
  read(): Promise<unknown | null>;
  remove(): Promise<void>;
}

export interface AdminDraftStorageOptions {
  draftAdapter?: AdminDraftPersistenceAdapter;
  legacyAdapter?: LegacyAdminDraftAdapter;
}

export type LegacyAdminDraftMigration =
  | { status: 'migrated'; draft: LegacyAdminDraft }
  | { status: 'no-legacy' }
  | { status: 'target-exists'; draft: AdminDraft };

export interface AdminDraftStorage {
  read(): Promise<AdminDraftReadResult<AdminDraft | null>>;
  claimLease(lease: AdminDraftLease): Promise<AdminDraftResult<void>>;
  write(record: CurrentAdminDraft, lease: AdminDraftLease): Promise<AdminDraftResult<void>>;
  remove(lease: AdminDraftLease): Promise<AdminDraftResult<void>>;
  removeSources(sources: readonly AdminDraftSource[], lease: AdminDraftLease): Promise<AdminDraftResult<void>>;
  migrateLegacy(lease: AdminDraftLease): Promise<AdminDraftResult<LegacyAdminDraftMigration>>;
  removeLegacy(lease: AdminDraftLease): Promise<AdminDraftResult<void>>;
}

export class AdminDraftStorageError extends Error {
  readonly code: AdminDraftFailureCode;

  constructor(code: AdminDraftFailureCode) {
    super(code);
    this.name = 'AdminDraftStorageError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSavedAt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

export function isCurrentAdminDraft(value: unknown): value is CurrentAdminDraft {
  if (!isRecord(value)) return false;
  return value.kind === 'current'
    && value.schemaVersion === ADMIN_DRAFT_SCHEMA_VERSION
    && typeof value.baseEtag === 'string'
    && value.baseEtag.trim().length > 0
    && isSiteContent(value.baseContent)
    && isSiteContent(value.content)
    && isValidSavedAt(value.savedAt);
}

export function isLegacyAdminDraft(value: unknown): value is LegacyAdminDraft {
  if (!isRecord(value)) return false;
  return value.kind === 'legacy'
    && value.schemaVersion === LEGACY_ADMIN_DRAFT_SCHEMA_VERSION
    && !Object.prototype.hasOwnProperty.call(value, 'baseEtag')
    && !Object.prototype.hasOwnProperty.call(value, 'baseContent')
    && isSiteContent(value.content)
    && isValidSavedAt(value.savedAt);
}

export function isAdminDraftLease(value: unknown): value is AdminDraftLease {
  if (!isRecord(value)) return false;
  return typeof value.ownerId === 'string'
    && value.ownerId.trim().length > 0
    && typeof value.generation === 'number'
    && Number.isSafeInteger(value.generation)
    && value.generation > 0;
}

function isSameAdminDraftLease(left: unknown, right: AdminDraftLease): boolean {
  return isAdminDraftLease(left)
    && left.ownerId === right.ownerId
    && left.generation === right.generation;
}

function decodePersistedDraft(value: unknown): AdminDraft | null {
  if (isCurrentAdminDraft(value)) {
    return {
      kind: 'current',
      schemaVersion: ADMIN_DRAFT_SCHEMA_VERSION,
      baseEtag: value.baseEtag,
      baseContent: value.baseContent,
      content: value.content,
      savedAt: value.savedAt,
    };
  }
  if (isLegacyAdminDraft(value)) {
    return {
      kind: 'legacy',
      schemaVersion: LEGACY_ADMIN_DRAFT_SCHEMA_VERSION,
      content: value.content,
      savedAt: value.savedAt,
    };
  }
  return null;
}

function decodeLegacyDraft(value: unknown): LegacyAdminDraft | null {
  if (!isRecord(value)) return null;

  const hasBase = Object.prototype.hasOwnProperty.call(value, 'baseEtag')
    || Object.prototype.hasOwnProperty.call(value, 'baseContent');
  const hasExpectedMetadata = (value.kind === undefined || value.kind === 'legacy')
    && (value.schemaVersion === undefined || value.schemaVersion === LEGACY_ADMIN_DRAFT_SCHEMA_VERSION);
  if (hasBase || !hasExpectedMetadata || !isSiteContent(value.content) || !isValidSavedAt(value.savedAt)) {
    return null;
  }

  return {
    kind: 'legacy',
    schemaVersion: LEGACY_ADMIN_DRAFT_SCHEMA_VERSION,
    content: value.content,
    savedAt: value.savedAt,
  };
}

function errorName(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return typeof error.name === 'string' ? error.name : null;
}

function failureCode(error: unknown, fallback: AdminDraftFailureCode): AdminDraftFailureCode {
  if (error instanceof AdminDraftStorageError) return error.code;

  const name = errorName(error);
  if (name === 'SecurityError') return 'security';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota-exceeded';
  if (name === 'NotSupportedError') return 'unavailable';
  return fallback;
}

function failure<T>(error: unknown, fallback: AdminDraftFailureCode): AdminDraftResult<T> {
  return { ok: false, code: failureCode(error, fallback) };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export interface IndexedDbAdminDraftAdapterOptions {
  databaseName?: string;
  objectStoreName?: string;
  recordKey?: IDBValidKey;
  leaseRecordKey?: IDBValidKey;
  indexedDb?: IDBFactory;
}

export function createIndexedDbAdminDraftAdapter(
  options: IndexedDbAdminDraftAdapterOptions = {},
): AdminDraftPersistenceAdapter {
  const databaseName = options.databaseName ?? ADMIN_DRAFT_DATABASE_NAME;
  const objectStoreName = options.objectStoreName ?? ADMIN_DRAFT_OBJECT_STORE_NAME;
  const recordKey = options.recordKey ?? ADMIN_DRAFT_RECORD_KEY;
  const leaseRecordKey = options.leaseRecordKey ?? ADMIN_DRAFT_LEASE_RECORD_KEY;
  let databasePromise: Promise<IDBDatabase> | null = null;

  const getIndexedDb = (): IDBFactory => {
    if (options.indexedDb) return options.indexedDb;
    if (typeof globalThis.indexedDB === 'undefined') {
      throw new AdminDraftStorageError('unavailable');
    }
    return globalThis.indexedDB;
  };

  const openDatabase = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = getIndexedDb().open(databaseName, 1);
      let blocked = false;

      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(objectStoreName)) {
          request.result.createObjectStore(objectStoreName);
        }
      };
      request.onblocked = () => {
        blocked = true;
        reject(new AdminDraftStorageError('unavailable'));
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to open the draft database'));
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = null;
        };
        resolve(request.result);
      };
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });

    return databasePromise;
  };

  const mutateIfLeaseCurrent = async (
    mutation: (store: IDBObjectStore) => void,
    lease: AdminDraftLease,
  ): Promise<boolean> => {
    const database = await openDatabase();
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(objectStoreName, 'readwrite');
      const store = transaction.objectStore(objectStoreName);
      const request = store.get(leaseRecordKey);
      let applied = false;

      request.onsuccess = () => {
        if (!isSameAdminDraftLease(request.result, lease)) return;
        applied = true;
        mutation(store);
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to verify the draft lease'));
      transaction.oncomplete = () => resolve(applied);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  };

  return {
    async read() {
      const database = await openDatabase();
      const transaction = database.transaction(objectStoreName, 'readonly');
      const request = transaction.objectStore(objectStoreName).get(recordKey);
      const [value] = await Promise.all([requestResult(request), transactionFinished(transaction)]);
      return value === undefined ? null : value;
    },
    async claimLease(lease) {
      const database = await openDatabase();
      const transaction = database.transaction(objectStoreName, 'readwrite');
      const request = transaction.objectStore(objectStoreName).put(lease, leaseRecordKey);
      await Promise.all([requestResult(request), transactionFinished(transaction)]);
    },
    async isLeaseCurrent(lease) {
      const database = await openDatabase();
      const transaction = database.transaction(objectStoreName, 'readonly');
      const request = transaction.objectStore(objectStoreName).get(leaseRecordKey);
      const [value] = await Promise.all([requestResult(request), transactionFinished(transaction)]);
      return isSameAdminDraftLease(value, lease);
    },
    write(record, lease) {
      return mutateIfLeaseCurrent((store) => {
        store.put(record, recordKey);
      }, lease);
    },
    remove(lease) {
      return mutateIfLeaseCurrent((store) => {
        store.delete(recordKey);
      }, lease);
    },
  };
}

type LocalStorageReader = Pick<Storage, 'getItem' | 'removeItem'>;

export interface LocalStorageLegacyAdminDraftAdapterOptions {
  key?: string;
  storage?: LocalStorageReader;
}

export function createLocalStorageLegacyAdminDraftAdapter(
  options: LocalStorageLegacyAdminDraftAdapterOptions = {},
): LegacyAdminDraftAdapter {
  const key = options.key ?? LEGACY_ADMIN_DRAFT_STORAGE_KEY;

  const getStorage = (): LocalStorageReader => {
    if (options.storage) return options.storage;
    if (typeof window === 'undefined') throw new AdminDraftStorageError('unavailable');
    return window.localStorage;
  };

  return {
    async read() {
      const serialized = getStorage().getItem(key);
      if (serialized === null) return null;
      try {
        return JSON.parse(serialized) as unknown;
      } catch {
        throw new AdminDraftStorageError('invalid-data');
      }
    },
    async remove() {
      getStorage().removeItem(key);
    },
  };
}

export function createAdminDraftStorage(options: AdminDraftStorageOptions = {}): AdminDraftStorage {
  const draftAdapter = options.draftAdapter ?? createIndexedDbAdminDraftAdapter();
  const legacyAdapter = options.legacyAdapter ?? createLocalStorageLegacyAdminDraftAdapter();
  let mutationQueue: Promise<void> = Promise.resolve();

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const readPersisted = async (): Promise<AdminDraftResult<AdminDraft | null>> => {
    let raw: unknown | null;
    try {
      raw = await draftAdapter.read();
    } catch (error) {
      return failure(error, 'read-failed');
    }
    if (raw === null) return { ok: true, value: null };
    if (
      isRecord(raw)
      && typeof raw.schemaVersion === 'number'
      && raw.schemaVersion > ADMIN_DRAFT_SCHEMA_VERSION
    ) {
      return { ok: false, code: 'unsupported-version' };
    }

    const draft = decodePersistedDraft(raw);
    return draft
      ? { ok: true, value: draft }
      : { ok: false, code: 'invalid-data' };
  };

  const readLegacy = async (): Promise<AdminDraftResult<LegacyAdminDraft | null>> => {
    let raw: unknown | null;
    try {
      raw = await legacyAdapter.read();
    } catch (error) {
      return failure(error, 'read-failed');
    }
    if (raw === null) return { ok: true, value: null };

    const draft = decodeLegacyDraft(raw);
    return draft
      ? { ok: true, value: draft }
      : { ok: false, code: 'invalid-data' };
  };

  const claimLease = async (lease: AdminDraftLease): Promise<AdminDraftResult<void>> => {
    if (!isAdminDraftLease(lease)) return { ok: false, code: 'invalid-data' };
    try {
      await draftAdapter.claimLease(lease);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error, 'write-failed');
    }
  };

  const writePersisted = async (
    record: AdminDraft,
    lease: AdminDraftLease,
  ): Promise<AdminDraftResult<void>> => {
    try {
      const applied = await draftAdapter.write(record, lease);
      return applied
        ? { ok: true, value: undefined }
        : { ok: false, code: 'stale-owner' };
    } catch (error) {
      return failure(error, 'write-failed');
    }
  };

  const removePersisted = async (lease: AdminDraftLease): Promise<AdminDraftResult<void>> => {
    try {
      const applied = await draftAdapter.remove(lease);
      return applied
        ? { ok: true, value: undefined }
        : { ok: false, code: 'stale-owner' };
    } catch (error) {
      return failure(error, 'delete-failed');
    }
  };

  const verifyLease = async (lease: AdminDraftLease): Promise<AdminDraftResult<void>> => {
    try {
      const current = await draftAdapter.isLeaseCurrent(lease);
      return current
        ? { ok: true, value: undefined }
        : { ok: false, code: 'stale-owner' };
    } catch (error) {
      return failure(error, 'read-failed');
    }
  };

  const removeLegacy = async (lease: AdminDraftLease): Promise<AdminDraftResult<void>> => {
    const verified = await verifyLease(lease);
    if (!verified.ok) return verified;
    try {
      await legacyAdapter.remove();
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error, 'delete-failed');
    }
  };

  const removeSources = async (
    sources: readonly AdminDraftSource[],
    lease: AdminDraftLease,
  ): Promise<AdminDraftResult<void>> => {
    const uniqueSources = new Set(sources);
    if (uniqueSources.has('indexeddb')) {
      const persisted = await removePersisted(lease);
      if (!persisted.ok) return persisted;
    }
    if (uniqueSources.has('legacy-local-storage')) {
      const legacy = await removeLegacy(lease);
      if (!legacy.ok) return legacy;
    }
    return { ok: true, value: undefined };
  };

  return {
    async read() {
      await mutationQueue;
      const persisted = await readPersisted();
      if (persisted.ok && persisted.value !== null) return persisted;
      if (!persisted.ok && persisted.code === 'unsupported-version') {
        return { ...persisted, source: 'indexeddb' };
      }
      if (!persisted.ok && persisted.code !== 'invalid-data') {
        return { ...persisted, source: 'indexeddb' };
      }

      const invalidSources: AdminDraftSource[] = persisted.ok ? [] : ['indexeddb'];
      const legacy = await readLegacy();
      if (legacy.ok) {
        return invalidSources.length > 0
          ? { ...legacy, invalidSources }
          : legacy;
      }

      const allInvalidSources = legacy.code === 'invalid-data'
        ? [...invalidSources, 'legacy-local-storage' as const]
        : invalidSources;
      return {
        ...legacy,
        source: 'legacy-local-storage',
        ...(allInvalidSources.length > 0 ? { invalidSources: allInvalidSources } : {}),
      };
    },
    claimLease(lease) {
      return enqueueMutation(() => claimLease(lease));
    },
    async write(record, lease) {
      if (!isCurrentAdminDraft(record)) return { ok: false, code: 'invalid-data' };
      if (!isAdminDraftLease(lease)) return { ok: false, code: 'invalid-data' };
      return enqueueMutation(() => writePersisted(record, lease));
    },
    remove(lease) {
      if (!isAdminDraftLease(lease)) return Promise.resolve({ ok: false, code: 'invalid-data' });
      return enqueueMutation(() => removePersisted(lease));
    },
    removeSources(sources, lease) {
      if (!isAdminDraftLease(lease)) return Promise.resolve({ ok: false, code: 'invalid-data' });
      return enqueueMutation(() => removeSources(sources, lease));
    },
    migrateLegacy(lease) {
      if (!isAdminDraftLease(lease)) return Promise.resolve({ ok: false, code: 'invalid-data' });
      return enqueueMutation(async () => {
        const persisted = await readPersisted();
        if (!persisted.ok) return persisted;
        if (persisted.value !== null) {
          return { ok: true, value: { status: 'target-exists', draft: persisted.value } };
        }

        const legacy = await readLegacy();
        if (!legacy.ok) return legacy;
        if (legacy.value === null) return { ok: true, value: { status: 'no-legacy' } };

        const written = await writePersisted(legacy.value, lease);
        if (!written.ok) return written;
        return { ok: true, value: { status: 'migrated', draft: legacy.value } };
      });
    },
    removeLegacy(lease) {
      if (!isAdminDraftLease(lease)) return Promise.resolve({ ok: false, code: 'invalid-data' });
      return enqueueMutation(() => removeLegacy(lease));
    },
  };
}

const defaultAdminDraftStorage = createAdminDraftStorage();

export function readAdminDraft(): Promise<AdminDraftReadResult<AdminDraft | null>> {
  return defaultAdminDraftStorage.read();
}

export function claimAdminDraftLease(lease: AdminDraftLease): Promise<AdminDraftResult<void>> {
  return defaultAdminDraftStorage.claimLease(lease);
}

export function writeAdminDraft(
  record: CurrentAdminDraft,
  lease: AdminDraftLease,
): Promise<AdminDraftResult<void>> {
  return defaultAdminDraftStorage.write(record, lease);
}

export function removeAdminDraft(lease: AdminDraftLease): Promise<AdminDraftResult<void>> {
  return defaultAdminDraftStorage.remove(lease);
}

export function removeAdminDraftSources(
  sources: readonly AdminDraftSource[],
  lease: AdminDraftLease,
): Promise<AdminDraftResult<void>> {
  return defaultAdminDraftStorage.removeSources(sources, lease);
}

export function migrateLegacyAdminDraft(
  lease: AdminDraftLease,
): Promise<AdminDraftResult<LegacyAdminDraftMigration>> {
  return defaultAdminDraftStorage.migrateLegacy(lease);
}

export function removeLegacyAdminDraft(lease: AdminDraftLease): Promise<AdminDraftResult<void>> {
  return defaultAdminDraftStorage.removeLegacy(lease);
}
