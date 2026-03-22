// ============================================================================
// BuilderGate Pane Split System - IndexedDB Promise Wrapper
// Low-level DB operations. NO React imports.
// ============================================================================

import { PANE_DB } from '../types/pane.types';

let dbInstance: IDBDatabase | null = null;

/**
 * Open (or return cached) IndexedDB instance.
 * Creates object stores on upgrade; handles version-change, error, and blocked events.
 */
export function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }

    const request = indexedDB.open(PANE_DB.NAME, PANE_DB.VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // paneLayouts store
      if (!db.objectStoreNames.contains(PANE_DB.STORES.PANE_LAYOUTS)) {
        const paneLayouts = db.createObjectStore(PANE_DB.STORES.PANE_LAYOUTS, {
          keyPath: 'sessionId',
        });
        paneLayouts.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }

      // savedLayouts store
      if (!db.objectStoreNames.contains(PANE_DB.STORES.SAVED_LAYOUTS)) {
        const savedLayouts = db.createObjectStore(PANE_DB.STORES.SAVED_LAYOUTS, {
          keyPath: 'id',
        });
        savedLayouts.createIndex('byName', 'name', { unique: false });
      }

      // sessionMeta store
      if (!db.objectStoreNames.contains(PANE_DB.STORES.SESSION_META)) {
        db.createObjectStore(PANE_DB.STORES.SESSION_META, {
          keyPath: 'sessionId',
        });
      }
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // If another tab upgrades the DB, close our stale connection
      db.onversionchange = () => {
        db.close();
        dbInstance = null;
      };

      dbInstance = db;
      resolve(db);
    };

    request.onerror = (event) => {
      const error = (event.target as IDBOpenDBRequest).error;
      reject(new Error(`Failed to open IndexedDB "${PANE_DB.NAME}": ${error?.message ?? 'unknown error'}`));
    };

    request.onblocked = () => {
      reject(
        new Error(
          `IndexedDB "${PANE_DB.NAME}" is blocked. Close other tabs using this database and try again.`,
        ),
      );
    };
  });
}

/**
 * Put (insert or update) a record into the given store.
 */
export async function dbPut<T>(storeName: string, data: T): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(data);

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error(`dbPut failed on "${storeName}": ${request.error?.message ?? 'unknown'}`));

    tx.onerror = () =>
      reject(new Error(`Transaction error in dbPut "${storeName}": ${tx.error?.message ?? 'unknown'}`));
  });
}

/**
 * Get a single record by key from the given store.
 * Returns undefined when the key does not exist.
 */
export async function dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () =>
      reject(new Error(`dbGet failed on "${storeName}": ${request.error?.message ?? 'unknown'}`));

    tx.onerror = () =>
      reject(new Error(`Transaction error in dbGet "${storeName}": ${tx.error?.message ?? 'unknown'}`));
  });
}

/**
 * Delete a record by key from the given store.
 */
export async function dbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error(`dbDelete failed on "${storeName}": ${request.error?.message ?? 'unknown'}`));

    tx.onerror = () =>
      reject(new Error(`Transaction error in dbDelete "${storeName}": ${tx.error?.message ?? 'unknown'}`));
  });
}

/**
 * Get all records from the given store.
 */
export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve((request.result as T[]) ?? []);
    request.onerror = () =>
      reject(new Error(`dbGetAll failed on "${storeName}": ${request.error?.message ?? 'unknown'}`));

    tx.onerror = () =>
      reject(new Error(`Transaction error in dbGetAll "${storeName}": ${tx.error?.message ?? 'unknown'}`));
  });
}

/**
 * Check whether IndexedDB is available in the current environment.
 */
export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Close the cached database instance (if any).
 */
export function closeDB(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
