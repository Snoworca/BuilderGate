import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampDialogRect,
  getDialogGeometryKey,
  readDialogGeometry,
  writeDialogGeometry,
} from '../../src/components/dialog/dialogGeometry.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  public failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('quota');
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function installStorage(storage: MemoryStorage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

test('getDialogGeometryKey returns the BuilderGate dialog storage key', () => {
  assert.equal(
    getDialogGeometryKey('command-preset-manager'),
    'buildergate.dialog.command-preset-manager.geometry',
  );
});

test('clampDialogRect keeps the dialog inside the viewport', () => {
  assert.deepEqual(
    clampDialogRect(
      { x: 900, y: -20, width: 600, height: 500 },
      { width: 1000, height: 700 },
      { width: 320, height: 240 },
    ),
    { x: 400, y: 0, width: 600, height: 500 },
  );
});

test('clampDialogRect handles a viewport smaller than the minimum size', () => {
  assert.deepEqual(
    clampDialogRect(
      { x: 10, y: 10, width: 640, height: 480 },
      { width: 240, height: 180 },
      { width: 320, height: 240 },
    ),
    { x: 0, y: 0, width: 240, height: 180 },
  );
});

test('readDialogGeometry restores persisted geometry and clamps it', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  storage.setItem(
    getDialogGeometryKey('dialog-a'),
    JSON.stringify({ schemaVersion: 1, x: 760, y: 500, width: 400, height: 300 }),
  );

  assert.deepEqual(
    readDialogGeometry(
      'dialog-a',
      { x: 20, y: 20, width: 640, height: 480 },
      { width: 1000, height: 700 },
      { width: 320, height: 240 },
    ),
    { x: 600, y: 400, width: 400, height: 300 },
  );
});

test('readDialogGeometry falls back to the default rect on corrupted JSON', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  storage.setItem(getDialogGeometryKey('dialog-b'), '{bad json');

  assert.deepEqual(
    readDialogGeometry(
      'dialog-b',
      { x: 20, y: 20, width: 640, height: 480 },
      { width: 1000, height: 700 },
      { width: 320, height: 240 },
    ),
    { x: 20, y: 20, width: 640, height: 480 },
  );
});

test('writeDialogGeometry stores JSON and tolerates quota failures', () => {
  const storage = new MemoryStorage();
  installStorage(storage);

  writeDialogGeometry('dialog-c', { x: 1, y: 2, width: 3, height: 4 });
  const raw = storage.getItem(getDialogGeometryKey('dialog-c'));
  assert.ok(raw);
  assert.equal(JSON.parse(raw).width, 3);

  storage.failWrites = true;
  assert.doesNotThrow(() => writeDialogGeometry('dialog-c', { x: 5, y: 6, width: 7, height: 8 }));
});
