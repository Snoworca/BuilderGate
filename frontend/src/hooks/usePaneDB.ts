// ============================================================================
// BuilderGate Pane Split System - React Hook for IndexedDB Pane Persistence
// Wraps paneDb.ts with retry logic, localStorage fallback, and migration.
// ============================================================================

import { useState, useEffect, useMemo } from 'react';
import { dbPut, dbGet, dbDelete, dbGetAll, isIndexedDBAvailable } from '../utils/paneDb';
import { buildPresetLayout, countPanes, flattenPaneTree } from '../utils/paneTree';
import type { PaneLayout, SavedLayoutRecord, PaneLayoutRecord } from '../types/pane.types';
import { PANE_DB, BUILT_IN_PRESETS, PLACEHOLDER_SESSION_ID } from '../types/pane.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LS_MIGRATION_FLAG = 'migrated_to_idb';

function lsLayoutKey(sessionId: string): string {
  return `pane_layout_${sessionId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deep-clone a PaneLayout and replace every sessionId with the placeholder.
 */
function replaceSessionIds(layout: PaneLayout): PaneLayout {
  const json = JSON.stringify(layout);
  // Replace any sessionId value that isn't already the placeholder
  const replaced = json.replace(
    /"sessionId"\s*:\s*"(?!__placeholder__)[^"]*"/g,
    `"sessionId":"${PLACEHOLDER_SESSION_ID}"`,
  );
  return JSON.parse(replaced) as PaneLayout;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UsePaneDBReturn {
  /** Persist a pane layout for a session. Retries up to 3 times, falls back to localStorage. */
  saveLayout: (sessionId: string, layout: PaneLayout) => Promise<void>;
  /** Load a persisted layout for a session. Returns null when nothing is stored. */
  loadLayout: (sessionId: string) => Promise<PaneLayout | null>;
  /** Remove a persisted layout for a session. */
  deleteLayout: (sessionId: string) => Promise<void>;
  /** Save the current layout as a reusable preset (sessionIds are replaced with placeholders). */
  savePreset: (name: string, layout: PaneLayout) => Promise<void>;
  /** Load all presets sorted: built-in first, then custom by createdAt desc. */
  loadPresets: () => Promise<SavedLayoutRecord[]>;
  /** Delete a custom preset. Throws if the preset is built-in. */
  deletePreset: (id: string) => Promise<void>;
  /** Idempotent: seed built-in presets into IndexedDB if they don't exist yet. */
  initBuiltInPresets: () => Promise<void>;
  /** One-time migration from legacy localStorage tab-state keys to IndexedDB. */
  migrateFromLocalStorage: () => Promise<void>;
  /** Whether IndexedDB is available in this environment. */
  isAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePaneDB(): UsePaneDBReturn {
  const [available] = useState<boolean>(() => isIndexedDBAvailable());

  // ------------------------------------------------------------------
  // saveLayout — retry 3 times with 100ms back-off, localStorage fallback
  // ------------------------------------------------------------------
  const saveLayout = useMemo(
    () => async (sessionId: string, layout: PaneLayout): Promise<void> => {
      const record: PaneLayoutRecord = {
        sessionId,
        layout,
        updatedAt: Date.now(),
      };

      if (!available) {
        localStorage.setItem(lsLayoutKey(sessionId), JSON.stringify(record));
        return;
      }

      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await dbPut<PaneLayoutRecord>(PANE_DB.STORES.PANE_LAYOUTS, record);
          return;
        } catch (err) {
          lastError = err;
          if (attempt < 2) {
            await delay(100);
          }
        }
      }

      // All retries failed — fall back to localStorage
      console.warn('usePaneDB.saveLayout: IDB failed after 3 retries, falling back to localStorage', lastError);
      try {
        localStorage.setItem(lsLayoutKey(sessionId), JSON.stringify(record));
      } catch (lsErr) {
        console.error('usePaneDB.saveLayout: localStorage fallback also failed', lsErr);
      }
    },
    [available],
  );

  // ------------------------------------------------------------------
  // loadLayout — IDB first, localStorage fallback
  // ------------------------------------------------------------------
  const loadLayout = useMemo(
    () => async (sessionId: string): Promise<PaneLayout | null> => {
      if (available) {
        try {
          const record = await dbGet<PaneLayoutRecord>(PANE_DB.STORES.PANE_LAYOUTS, sessionId);
          if (record) return record.layout;
        } catch (err) {
          console.warn('usePaneDB.loadLayout: IDB read failed, trying localStorage', err);
        }
      }

      // localStorage fallback
      try {
        const raw = localStorage.getItem(lsLayoutKey(sessionId));
        if (raw) {
          const parsed = JSON.parse(raw) as PaneLayoutRecord;
          return parsed.layout;
        }
      } catch {
        // corrupt data — ignore
      }

      return null;
    },
    [available],
  );

  // ------------------------------------------------------------------
  // deleteLayout
  // ------------------------------------------------------------------
  const deleteLayout = useMemo(
    () => async (sessionId: string): Promise<void> => {
      if (available) {
        try {
          await dbDelete(PANE_DB.STORES.PANE_LAYOUTS, sessionId);
          return;
        } catch (err) {
          console.warn('usePaneDB.deleteLayout: IDB delete failed, removing from localStorage', err);
        }
      }
      localStorage.removeItem(lsLayoutKey(sessionId));
    },
    [available],
  );

  // ------------------------------------------------------------------
  // savePreset — replace sessionIds, handle QuotaExceededError
  // ------------------------------------------------------------------
  const savePreset = useMemo(
    () => async (name: string, layout: PaneLayout): Promise<void> => {
      const sanitized = replaceSessionIds(layout);
      const panes = countPanes(sanitized.root);
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const record: SavedLayoutRecord = {
        id,
        name,
        layout: sanitized,
        isBuiltIn: false,
        paneCount: panes,
        createdAt: Date.now(),
      };

      try {
        await dbPut<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS, record);
      } catch (err: unknown) {
        // Handle QuotaExceededError: auto-delete the oldest custom preset and retry
        const isQuota =
          err instanceof DOMException &&
          (err.name === 'QuotaExceededError' || err.code === 22);

        if (isQuota) {
          console.warn('usePaneDB.savePreset: QuotaExceededError — removing oldest custom preset');
          try {
            const all = await dbGetAll<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS);
            const customs = all
              .filter((r) => !r.isBuiltIn)
              .sort((a, b) => a.createdAt - b.createdAt);

            if (customs.length > 0) {
              await dbDelete(PANE_DB.STORES.SAVED_LAYOUTS, customs[0].id);
              // Retry once after freeing space
              await dbPut<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS, record);
              return;
            }
          } catch (innerErr) {
            console.error('usePaneDB.savePreset: could not recover from quota error', innerErr);
          }
        }

        throw err;
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // loadPresets — built-in first, then custom by createdAt desc
  // ------------------------------------------------------------------
  const loadPresets = useMemo(
    () => async (): Promise<SavedLayoutRecord[]> => {
      const all = await dbGetAll<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS);

      const builtIn: SavedLayoutRecord[] = [];
      const custom: SavedLayoutRecord[] = [];

      for (const record of all) {
        if (record.isBuiltIn) {
          builtIn.push(record);
        } else {
          custom.push(record);
        }
      }

      // Stable order for built-in: match BUILT_IN_PRESETS array order
      const builtInOrder = new Map(BUILT_IN_PRESETS.map((p, i) => [p.id, i]));
      builtIn.sort((a, b) => (builtInOrder.get(a.id) ?? 999) - (builtInOrder.get(b.id) ?? 999));

      // Custom by createdAt descending (newest first)
      custom.sort((a, b) => b.createdAt - a.createdAt);

      return [...builtIn, ...custom];
    },
    [],
  );

  // ------------------------------------------------------------------
  // deletePreset — reject built-in
  // ------------------------------------------------------------------
  const deletePreset = useMemo(
    () => async (id: string): Promise<void> => {
      const record = await dbGet<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS, id);
      if (record?.isBuiltIn) {
        throw new Error(`Cannot delete built-in preset "${record.name}" (id: ${id})`);
      }
      await dbDelete(PANE_DB.STORES.SAVED_LAYOUTS, id);
    },
    [],
  );

  // ------------------------------------------------------------------
  // initBuiltInPresets — idempotent seed
  // ------------------------------------------------------------------
  const initBuiltInPresets = useMemo(
    () => async (): Promise<void> => {
      if (!available) return;

      for (const preset of BUILT_IN_PRESETS) {
        const existing = await dbGet<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS, preset.id);
        if (existing) continue;

        const placeholderIds = Array.from({ length: preset.paneCount }, () => PLACEHOLDER_SESSION_ID);
        const layout = buildPresetLayout(preset.type, placeholderIds);

        const record: SavedLayoutRecord = {
          id: preset.id,
          name: preset.name,
          layout,
          isBuiltIn: true,
          paneCount: preset.paneCount,
          createdAt: 0, // epoch — always sort before custom
        };

        await dbPut<SavedLayoutRecord>(PANE_DB.STORES.SAVED_LAYOUTS, record);
      }
    },
    [available],
  );

  // ------------------------------------------------------------------
  // migrateFromLocalStorage
  // ------------------------------------------------------------------
  const migrateFromLocalStorage = useMemo(
    () => async (): Promise<void> => {
      if (!available) return;

      // Already migrated?
      if (localStorage.getItem(LS_MIGRATION_FLAG) === 'true') return;

      try {
        const keysToMigrate: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('tab_state_')) {
            keysToMigrate.push(key);
          }
        }

        for (const key of keysToMigrate) {
          const raw = localStorage.getItem(key);
          if (!raw) continue;

          try {
            const parsed = JSON.parse(raw);
            // Extract a session id from the key: "tab_state_<sessionId>"
            const sessionId = key.replace('tab_state_', '');

            // Build a minimal PaneLayout: single terminal leaf
            const leaf = {
              type: 'terminal' as const,
              id: `migrated-${sessionId}`,
              sessionId,
            };

            const layout: PaneLayout = {
              root: leaf,
              focusedPaneId: leaf.id,
              zoomedPaneId: null,
            };

            const record: PaneLayoutRecord = {
              sessionId,
              layout,
              updatedAt: Date.now(),
            };

            await dbPut<PaneLayoutRecord>(PANE_DB.STORES.PANE_LAYOUTS, record);
          } catch {
            // Skip corrupt entries — don't abort the whole migration
            console.warn(`usePaneDB.migrateFromLocalStorage: skipping corrupt key "${key}"`);
          }
        }

        // Only set the flag after ALL keys processed successfully
        // Note: we intentionally do NOT delete old localStorage keys
        localStorage.setItem(LS_MIGRATION_FLAG, 'true');
      } catch (err) {
        // On any failure, do NOT set the flag so migration retries next time
        console.warn('usePaneDB.migrateFromLocalStorage: migration failed, will retry next load', err);
      }
    },
    [available],
  );

  // ------------------------------------------------------------------
  // Initialization on mount
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!available) return;

    initBuiltInPresets().catch((err) =>
      console.warn('usePaneDB: initBuiltInPresets failed', err),
    );

    migrateFromLocalStorage().catch((err) =>
      console.warn('usePaneDB: migrateFromLocalStorage failed', err),
    );
  }, [available, initBuiltInPresets, migrateFromLocalStorage]);

  // ------------------------------------------------------------------
  // Return
  // ------------------------------------------------------------------
  return useMemo<UsePaneDBReturn>(
    () => ({
      saveLayout,
      loadLayout,
      deleteLayout,
      savePreset,
      loadPresets,
      deletePreset,
      initBuiltInPresets,
      migrateFromLocalStorage,
      isAvailable: available,
    }),
    [
      saveLayout,
      loadLayout,
      deleteLayout,
      savePreset,
      loadPresets,
      deletePreset,
      initBuiltInPresets,
      migrateFromLocalStorage,
      available,
    ],
  );
}
