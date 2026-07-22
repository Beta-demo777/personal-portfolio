export type StorageFailureCode =
  | 'unavailable'
  | 'security'
  | 'quota-exceeded'
  | 'read-failed'
  | 'write-failed'
  | 'remove-failed'
  | 'invalid-json'
  | 'invalid-value'
  | 'serialization-failed';

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: StorageFailureCode };

type ValueGuard<T> = (value: unknown) => value is T;

function failureCode(error: unknown, fallback: StorageFailureCode): StorageFailureCode {
  if (error instanceof DOMException) {
    if (error.name === 'SecurityError') return 'security';
    if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return 'quota-exceeded';
    }
  }
  return fallback;
}

function getStorage(): StorageResult<Storage> {
  if (typeof window === 'undefined') return { ok: false, code: 'unavailable' };

  try {
    return { ok: true, value: window.localStorage };
  } catch (error) {
    return { ok: false, code: failureCode(error, 'unavailable') };
  }
}

export function readStorageValue(key: string): StorageResult<string | null> {
  const storage = getStorage();
  if (storage.ok === false) return { ok: false, code: storage.code };

  try {
    return { ok: true, value: storage.value.getItem(key) };
  } catch (error) {
    return { ok: false, code: failureCode(error, 'read-failed') };
  }
}

export function readStorageJson<T>(key: string, isValid: ValueGuard<T>): StorageResult<T | null> {
  const stored = readStorageValue(key);
  if (stored.ok === false) return { ok: false, code: stored.code };
  if (stored.value === null) return { ok: true, value: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.value) as unknown;
  } catch {
    return { ok: false, code: 'invalid-json' };
  }

  return isValid(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, code: 'invalid-value' };
}

export function writeStorageValue(key: string, value: string): StorageResult<void> {
  const storage = getStorage();
  if (storage.ok === false) return { ok: false, code: storage.code };

  try {
    storage.value.setItem(key, value);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, code: failureCode(error, 'write-failed') };
  }
}

export function writeStorageJson<T>(key: string, value: T): StorageResult<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, code: 'serialization-failed' };
  }
  return writeStorageValue(key, serialized);
}

export function removeStorageValue(key: string): StorageResult<void> {
  const storage = getStorage();
  if (storage.ok === false) return { ok: false, code: storage.code };

  try {
    storage.value.removeItem(key);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, code: failureCode(error, 'remove-failed') };
  }
}
