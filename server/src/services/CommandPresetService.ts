import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import type {
  CommandPreset,
  CommandPresetFile,
  CommandPresetKind,
  CreateCommandPresetInput,
  UpdateCommandPresetInput,
} from '../types/commandPreset.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface CommandPresetServiceOptions {
  dataPath?: string;
}

const KINDS: CommandPresetKind[] = ['command', 'directory', 'prompt'];
const DEFAULT_DATA_PATH = './data/command-presets.json';
const MAX_LABEL_LENGTH = 80;
const MAX_VALUE_LENGTH = 12000;

export class CommandPresetService {
  private presets: CommandPreset[] = [];
  private readonly dataFilePath: string;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: CommandPresetServiceOptions = {}) {
    this.dataFilePath = path.resolve(options.dataPath ?? DEFAULT_DATA_PATH);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.dataFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.dataFilePath, 'utf-8');
      const file = JSON.parse(raw) as CommandPresetFile;
      if (file.version === 1 && Array.isArray(file.presets)) {
        this.presets = this.sanitizeLoadedPresets(file.presets);
        await this.flushToDisk();
        return;
      }
      throw new Error('Invalid command preset file format');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.presets = [];
        await this.flushToDisk();
        return;
      }

      console.warn('[CommandPresetService] Failed to load command-presets.json:', error.message);
      await this.recoverFromBackup();
    }
  }

  getAll(): CommandPreset[] {
    return this.sortedPresets().map(preset => ({ ...preset }));
  }

  getDataFilePath(): string {
    return this.dataFilePath;
  }

  async createPreset(input: CreateCommandPresetInput): Promise<CommandPreset> {
    return this.runSerializedMutation(async () => {
      const kind = this.validateKind(input.kind);
      const label = this.validateLabel(input.label);
      const value = this.validateValue(input.value);
      const now = new Date().toISOString();
      const preset: CommandPreset = {
        id: uuidv4(),
        kind,
        label,
        value,
        sortOrder: this.presets.filter(item => item.kind === kind).length,
        createdAt: now,
        updatedAt: now,
      };

      this.presets.push(preset);
      await this.flushToDisk();
      return { ...preset };
    });
  }

  async updatePreset(id: string, input: UpdateCommandPresetInput): Promise<CommandPreset> {
    return this.runSerializedMutation(async () => {
      const preset = this.findPreset(id);
      if (input.label !== undefined) {
        preset.label = this.validateLabel(input.label);
      }
      if (input.value !== undefined) {
        preset.value = this.validateValue(input.value);
      }
      preset.updatedAt = new Date().toISOString();
      await this.flushToDisk();
      return { ...preset };
    });
  }

  async deletePreset(id: string): Promise<void> {
    await this.runSerializedMutation(async () => {
      const preset = this.findPreset(id);
      this.presets = this.presets.filter(item => item.id !== id);
      this.reindexKind(preset.kind);
      await this.flushToDisk();
    });
  }

  async reorderPresets(kind: CommandPresetKind, presetIds: string[]): Promise<void> {
    await this.runSerializedMutation(async () => {
      const targetKind = this.validateKind(kind);
      const kindPresets = this.presets.filter(item => item.kind === targetKind);
      const existingIds = new Set(kindPresets.map(item => item.id));
      const requestedIds = new Set(presetIds);

      if (presetIds.length !== kindPresets.length) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Preset order must include every preset in the selected kind');
      }
      for (const id of presetIds) {
        if (!existingIds.has(id) || requestedIds.size !== presetIds.length) {
          throw new AppError(ErrorCode.INVALID_INPUT, 'Preset order contains an unknown or duplicate id');
        }
      }

      const order = new Map(presetIds.map((id, index) => [id, index]));
      for (const preset of this.presets) {
        if (preset.kind === targetKind) {
          preset.sortOrder = order.get(preset.id) ?? preset.sortOrder;
          preset.updatedAt = new Date().toISOString();
        }
      }

      await this.flushToDisk();
    });
  }

  private async recoverFromBackup(): Promise<void> {
    const bakPath = this.dataFilePath + '.bak';
    try {
      const raw = await fs.readFile(bakPath, 'utf-8');
      const file = JSON.parse(raw) as CommandPresetFile;
      if (file.version !== 1 || !Array.isArray(file.presets)) {
        throw new Error('Invalid backup format');
      }
      this.presets = this.sanitizeLoadedPresets(file.presets);
      console.log('[CommandPresetService] Recovered from backup');
      await this.flushToDisk();
    } catch {
      console.warn('[CommandPresetService] Backup also failed, starting with an empty preset list');
      this.presets = [];
      await this.flushToDisk();
    }
  }

  private sanitizeLoadedPresets(presets: CommandPreset[]): CommandPreset[] {
    const sanitized: CommandPreset[] = [];
    for (const preset of presets) {
      if (!KINDS.includes(preset.kind)) continue;
      try {
        sanitized.push({
          id: typeof preset.id === 'string' && preset.id.trim() ? preset.id : uuidv4(),
          kind: preset.kind,
          label: this.validateLabel(preset.label),
          value: this.validateValue(preset.value),
          sortOrder: Number.isFinite(preset.sortOrder) ? preset.sortOrder : sanitized.length,
          createdAt: typeof preset.createdAt === 'string' ? preset.createdAt : new Date().toISOString(),
          updatedAt: typeof preset.updatedAt === 'string' ? preset.updatedAt : new Date().toISOString(),
        });
      } catch {
        console.warn('[CommandPresetService] Dropped invalid command preset during load');
      }
    }

    this.reindexAll(sanitized);
    return sanitized;
  }

  private sortedPresets(): CommandPreset[] {
    return [...this.presets].sort((a, b) => {
      const kindDelta = KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
      if (kindDelta !== 0) return kindDelta;
      return a.sortOrder - b.sortOrder;
    });
  }

  private reindexAll(target = this.presets): void {
    for (const kind of KINDS) {
      target
        .filter(item => item.kind === kind)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .forEach((item, index) => {
          item.sortOrder = index;
        });
    }
  }

  private reindexKind(kind: CommandPresetKind): void {
    this.presets
      .filter(item => item.kind === kind)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((item, index) => {
        item.sortOrder = index;
      });
  }

  private findPreset(id: string): CommandPreset {
    const preset = this.presets.find(item => item.id === id);
    if (!preset) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Command preset not found');
    }
    return preset;
  }

  private async runSerializedMutation<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const snapshot = this.clonePresets(this.presets);
      try {
        return await operation();
      } catch (error) {
        this.presets = snapshot;
        throw error;
      }
    };
    const result = this.mutationChain.then(execute, execute);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private clonePresets(presets: CommandPreset[]): CommandPreset[] {
    return presets.map(preset => ({ ...preset }));
  }

  private validateKind(kind: unknown): CommandPresetKind {
    if (KINDS.includes(kind as CommandPresetKind)) {
      return kind as CommandPresetKind;
    }
    throw new AppError(ErrorCode.INVALID_INPUT, 'Unsupported command preset kind');
  }

  private validateLabel(label: unknown): string {
    if (typeof label !== 'string') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Command preset label is required');
    }
    const trimmed = label.trim();
    if (!trimmed || trimmed.length > MAX_LABEL_LENGTH) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Command preset label must be 1-80 characters');
    }
    return trimmed;
  }

  private validateValue(value: unknown): string {
    if (typeof value !== 'string') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Command preset value is required');
    }
    if (!value.trim() || value.length > MAX_VALUE_LENGTH || /[\x00]/.test(value)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Command preset value is invalid');
    }
    return value;
  }

  private async flushToDisk(): Promise<void> {
    const file: CommandPresetFile = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      presets: this.sortedPresets(),
    };
    const tmpPath = this.dataFilePath + '.tmp';
    const bakPath = this.dataFilePath + '.bak';

    try {
      await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        await fs.copyFile(this.dataFilePath, bakPath);
      } catch {
        // No existing file to backup.
      }
      await fs.rename(tmpPath, this.dataFilePath);
    } catch (error: any) {
      console.error('[CommandPresetService] Flush failed:', error.message);
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup failures.
      }
      throw new AppError(ErrorCode.CONFIG_PERSIST_FAILED, 'Failed to persist command presets');
    }
  }
}
