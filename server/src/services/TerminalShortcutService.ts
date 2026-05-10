import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import type {
  CreateTerminalShortcutBindingInput,
  ResetTerminalShortcutScopeInput,
  SetTerminalShortcutProfileInput,
  TerminalShortcutAction,
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutProfile,
  TerminalShortcutProfileSelection,
  TerminalShortcutScope,
  TerminalShortcutState,
  UpdateTerminalShortcutBindingInput,
} from '../types/terminalShortcut.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface TerminalShortcutServiceOptions {
  dataPath?: string;
}

interface TerminalShortcutStateSnapshot {
  profileSelections: TerminalShortcutProfileSelection[];
  bindings: TerminalShortcutBinding[];
}

const DEFAULT_DATA_PATH = './data/terminal-shortcuts.json';
const SCOPES: TerminalShortcutScope[] = ['global', 'workspace', 'session'];
const PROFILES: TerminalShortcutProfile[] = ['xterm-default', 'ai-tui-compat', 'custom'];
const MAX_SEND_DATA_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 160;
const MAX_LABEL_LENGTH = 80;
const MAX_KEY_LENGTH = 64;
const MAX_CODE_LENGTH = 80;

export class TerminalShortcutService {
  private profileSelections: TerminalShortcutProfileSelection[] = [];
  private bindings: TerminalShortcutBinding[] = [];
  private readonly dataFilePath: string;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: TerminalShortcutServiceOptions = {}) {
    this.dataFilePath = path.resolve(options.dataPath ?? DEFAULT_DATA_PATH);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.dataFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.dataFilePath, 'utf-8');
      const file = JSON.parse(raw) as TerminalShortcutState;
      if (file.version === 1 && Array.isArray(file.profileSelections) && Array.isArray(file.bindings)) {
        this.profileSelections = this.sanitizeLoadedProfileSelections(file.profileSelections);
        this.bindings = this.sanitizeLoadedBindings(file.bindings);
        this.ensureDefaultGlobalProfile();
        await this.flushToDisk();
        return;
      }
      throw new Error('Invalid terminal shortcut file format');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.profileSelections = [];
        this.bindings = [];
        this.ensureDefaultGlobalProfile();
        await this.flushToDisk();
        return;
      }

      console.warn('[TerminalShortcutService] Failed to load terminal-shortcuts.json:', error.message);
      await this.recoverFromBackup();
    }
  }

  getState(): TerminalShortcutState {
    return this.buildState();
  }

  getDataFilePath(): string {
    return this.dataFilePath;
  }

  async setProfileSelection(input: SetTerminalShortcutProfileInput): Promise<TerminalShortcutState> {
    return this.runSerializedMutation(async () => {
      const scopeTarget = this.validateScopeTarget(input);
      const profile = this.validateProfile(input.profile);
      const now = new Date().toISOString();
      this.profileSelections = this.profileSelections.filter(selection => !this.isSameScopeTarget(selection, scopeTarget));
      this.profileSelections.push({
        ...scopeTarget,
        profile,
        updatedAt: now,
      });
      this.ensureDefaultGlobalProfile();
      await this.flushToDisk();
      return this.buildState();
    });
  }

  async createBinding(input: CreateTerminalShortcutBindingInput): Promise<TerminalShortcutBinding> {
    return this.runSerializedMutation(async () => {
      const scopeTarget = this.validateScopeTarget(input);
      const keyDescriptor = this.validateKeyDescriptor(input);
      this.rejectReservedShortcut(keyDescriptor);
      const action = this.validateAction(input.action);
      const now = new Date().toISOString();
      const binding: TerminalShortcutBinding = {
        id: uuidv4(),
        ...scopeTarget,
        ...keyDescriptor,
        profile: input.profile === undefined ? undefined : this.validateProfile(input.profile),
        action,
        enabled: this.validateOptionalBoolean(input.enabled, true, 'enabled'),
        allowRepeat: this.validateOptionalBoolean(input.allowRepeat, false, 'allowRepeat'),
        matchByKeyFallback: this.validateOptionalBoolean(input.matchByKeyFallback, false, 'matchByKeyFallback'),
        description: input.description === undefined ? undefined : this.validateDescription(input.description),
        sortOrder: this.bindings.filter(item => this.isSameScopeTarget(item, scopeTarget)).length,
        createdAt: now,
        updatedAt: now,
      };

      this.bindings.push(binding);
      await this.flushToDisk();
      return this.cloneBinding(binding);
    });
  }

  async updateBinding(id: string, input: UpdateTerminalShortcutBindingInput): Promise<TerminalShortcutBinding> {
    return this.runSerializedMutation(async () => {
      const binding = this.findBinding(id);
      const merged = {
        ...binding,
        ...input,
        action: input.action === undefined ? binding.action : input.action,
      };
      const scopeTarget = this.validateScopeTarget(merged);
      const keyDescriptor = this.validateKeyDescriptor(merged);
      this.rejectReservedShortcut(keyDescriptor);

      Object.assign(binding, {
        ...scopeTarget,
        ...keyDescriptor,
        profile: merged.profile === undefined ? undefined : this.validateProfile(merged.profile),
        action: this.validateAction(merged.action),
        enabled: this.validateOptionalBoolean(merged.enabled, binding.enabled, 'enabled'),
        allowRepeat: this.validateOptionalBoolean(merged.allowRepeat, binding.allowRepeat, 'allowRepeat'),
        matchByKeyFallback: this.validateOptionalBoolean(
          merged.matchByKeyFallback,
          binding.matchByKeyFallback,
          'matchByKeyFallback',
        ),
        description: merged.description === undefined ? undefined : this.validateDescription(merged.description),
        updatedAt: new Date().toISOString(),
      });

      await this.flushToDisk();
      return this.cloneBinding(binding);
    });
  }

  async deleteBinding(id: string): Promise<void> {
    await this.runSerializedMutation(async () => {
      const binding = this.findBinding(id);
      this.bindings = this.bindings.filter(item => item.id !== id);
      this.reindexScopeTarget(binding);
      await this.flushToDisk();
    });
  }

  async resetScope(input: ResetTerminalShortcutScopeInput): Promise<TerminalShortcutState> {
    return this.runSerializedMutation(async () => {
      const scopeTarget = this.validateScopeTarget(input);
      this.profileSelections = this.profileSelections.filter(selection => !this.isSameScopeTarget(selection, scopeTarget));
      this.bindings = this.bindings.filter(binding => !this.isSameScopeTarget(binding, scopeTarget));
      this.ensureDefaultGlobalProfile();
      this.reindexAllBindings();
      await this.flushToDisk();
      return this.buildState();
    });
  }

  private async recoverFromBackup(): Promise<void> {
    const bakPath = this.dataFilePath + '.bak';
    try {
      const raw = await fs.readFile(bakPath, 'utf-8');
      const file = JSON.parse(raw) as TerminalShortcutState;
      if (file.version !== 1 || !Array.isArray(file.profileSelections) || !Array.isArray(file.bindings)) {
        throw new Error('Invalid backup format');
      }
      this.profileSelections = this.sanitizeLoadedProfileSelections(file.profileSelections);
      this.bindings = this.sanitizeLoadedBindings(file.bindings);
      this.ensureDefaultGlobalProfile();
      console.log('[TerminalShortcutService] Recovered from backup');
      await this.flushToDisk();
    } catch {
      console.warn('[TerminalShortcutService] Backup also failed, starting with an empty terminal shortcut state');
      this.profileSelections = [];
      this.bindings = [];
      this.ensureDefaultGlobalProfile();
      await this.flushToDisk();
    }
  }

  private sanitizeLoadedProfileSelections(selections: TerminalShortcutProfileSelection[]): TerminalShortcutProfileSelection[] {
    const sanitized: TerminalShortcutProfileSelection[] = [];
    for (const selection of selections) {
      try {
        sanitized.push({
          ...this.validateScopeTarget(selection),
          profile: this.validateProfile(selection.profile),
          updatedAt: typeof selection.updatedAt === 'string' ? selection.updatedAt : new Date().toISOString(),
        });
      } catch {
        console.warn('[TerminalShortcutService] Dropped invalid profile selection during load');
      }
    }
    return sanitized;
  }

  private sanitizeLoadedBindings(bindings: TerminalShortcutBinding[]): TerminalShortcutBinding[] {
    const sanitized: TerminalShortcutBinding[] = [];
    for (const binding of bindings) {
      try {
        const scopeTarget = this.validateScopeTarget(binding);
        const keyDescriptor = this.validateKeyDescriptor(binding);
        this.rejectReservedShortcut(keyDescriptor);
        sanitized.push({
          id: typeof binding.id === 'string' && binding.id.trim() ? binding.id : uuidv4(),
          ...scopeTarget,
          ...keyDescriptor,
          profile: binding.profile === undefined ? undefined : this.validateProfile(binding.profile),
          action: this.validateAction(binding.action),
          enabled: typeof binding.enabled === 'boolean' ? binding.enabled : true,
          allowRepeat: typeof binding.allowRepeat === 'boolean' ? binding.allowRepeat : false,
          matchByKeyFallback: typeof binding.matchByKeyFallback === 'boolean' ? binding.matchByKeyFallback : false,
          description: binding.description === undefined ? undefined : this.validateDescription(binding.description),
          sortOrder: Number.isFinite(binding.sortOrder) ? binding.sortOrder : sanitized.length,
          createdAt: typeof binding.createdAt === 'string' ? binding.createdAt : new Date().toISOString(),
          updatedAt: typeof binding.updatedAt === 'string' ? binding.updatedAt : new Date().toISOString(),
        });
      } catch {
        console.warn('[TerminalShortcutService] Dropped invalid shortcut binding during load');
      }
    }

    this.reindexAllBindings(sanitized);
    return sanitized;
  }

  private validateScopeTarget(input: {
    scope?: unknown;
    workspaceId?: unknown;
    sessionId?: unknown;
  }): Pick<TerminalShortcutBinding, 'scope' | 'workspaceId' | 'sessionId'> {
    const scope = this.validateScope(input.scope);
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim()
      ? input.workspaceId.trim()
      : undefined;
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim()
      ? input.sessionId.trim()
      : undefined;

    if (scope === 'workspace' && !workspaceId) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Workspace shortcut scope requires workspaceId');
    }
    if (scope === 'session' && !sessionId) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Session shortcut scope requires sessionId');
    }

    return {
      scope,
      ...(scope === 'workspace' ? { workspaceId } : {}),
      ...(scope === 'session' ? { sessionId } : {}),
    };
  }

  private validateScope(scope: unknown): TerminalShortcutScope {
    if (SCOPES.includes(scope as TerminalShortcutScope)) {
      return scope as TerminalShortcutScope;
    }
    throw new AppError(ErrorCode.INVALID_INPUT, 'Unsupported terminal shortcut scope');
  }

  private validateProfile(profile: unknown): TerminalShortcutProfile {
    if (PROFILES.includes(profile as TerminalShortcutProfile)) {
      return profile as TerminalShortcutProfile;
    }
    throw new AppError(ErrorCode.INVALID_INPUT, 'Unsupported terminal shortcut profile');
  }

  private validateKeyDescriptor(input: Partial<TerminalShortcutKeyDescriptor>): TerminalShortcutKeyDescriptor {
    return {
      key: this.validateKeyValue(input.key),
      code: this.validateKeyText(input.code, 'code', MAX_CODE_LENGTH),
      ctrlKey: this.validateBoolean(input.ctrlKey, 'ctrlKey'),
      shiftKey: this.validateBoolean(input.shiftKey, 'shiftKey'),
      altKey: this.validateBoolean(input.altKey, 'altKey'),
      metaKey: this.validateBoolean(input.metaKey, 'metaKey'),
      location: this.validateLocation(input.location),
      repeat: typeof input.repeat === 'boolean' ? input.repeat : false,
    };
  }

  private validateAction(action: unknown): TerminalShortcutAction {
    if (!action || typeof action !== 'object') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut action is required');
    }
    const typed = action as Partial<TerminalShortcutAction>;
    if (typed.type === 'send') {
      const data = (typed as { data?: unknown }).data;
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_SEND_DATA_LENGTH || /\x00/.test(data)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut send data is invalid');
      }
      const label = (typed as { label?: unknown }).label;
      return {
        type: 'send',
        data,
        ...(typeof label === 'string' && label.trim()
          ? { label: this.truncateTrimmed(label, MAX_LABEL_LENGTH) }
          : {}),
      };
    }
    if (typed.type === 'pass-through') {
      return { type: 'pass-through' };
    }
    if (typed.type === 'block') {
      return { type: 'block' };
    }
    throw new AppError(ErrorCode.INVALID_INPUT, 'Unsupported terminal shortcut action');
  }

  private validateKeyText(value: unknown, fieldName: string, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new AppError(ErrorCode.INVALID_INPUT, `Terminal shortcut ${fieldName} is required`);
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength || /\x00/.test(trimmed)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `Terminal shortcut ${fieldName} is invalid`);
    }
    return trimmed;
  }

  private validateBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    throw new AppError(ErrorCode.INVALID_INPUT, `Terminal shortcut ${fieldName} must be boolean`);
  }

  private validateOptionalBoolean(value: unknown, fallback: boolean, fieldName: string): boolean {
    if (value === undefined) {
      return fallback;
    }
    return this.validateBoolean(value, fieldName);
  }

  private validateLocation(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut location must be 0-3');
    }
    return value;
  }

  private validateKeyValue(value: unknown): string {
    if (typeof value !== 'string') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut key is required');
    }
    if (value.length === 0 || value.length > MAX_KEY_LENGTH || /\x00/.test(value)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut key is invalid');
    }
    return value;
  }

  private validateDescription(description: unknown): string | undefined {
    if (description === undefined || description === null) {
      return undefined;
    }
    if (typeof description !== 'string') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut description is invalid');
    }
    const trimmed = description.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > MAX_DESCRIPTION_LENGTH || /\x00/.test(trimmed)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut description is invalid');
    }
    return trimmed;
  }

  private rejectReservedShortcut(descriptor: TerminalShortcutKeyDescriptor): void {
    if (!descriptor.ctrlKey || descriptor.altKey || descriptor.metaKey) {
      return;
    }
    const normalizedKey = descriptor.key.toLowerCase();
    const normalizedCode = descriptor.code.toLowerCase();
    if (
      normalizedKey === 'c'
      || normalizedKey === 'v'
      || normalizedCode === 'keyc'
      || normalizedCode === 'keyv'
    ) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Ctrl+C and Ctrl+V terminal shortcuts are reserved');
    }
  }

  private truncateTrimmed(value: string, maxLength: number): string {
    return value.trim().slice(0, maxLength);
  }

  private findBinding(id: string): TerminalShortcutBinding {
    const binding = this.bindings.find(item => item.id === id);
    if (!binding) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Terminal shortcut binding not found');
    }
    return binding;
  }

  private ensureDefaultGlobalProfile(): void {
    if (this.profileSelections.some(selection => selection.scope === 'global')) {
      return;
    }
    this.profileSelections.push({
      scope: 'global',
      profile: 'xterm-default',
      updatedAt: new Date().toISOString(),
    });
  }

  private buildState(): TerminalShortcutState {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      profileSelections: this.sortedProfileSelections().map(selection => ({ ...selection })),
      bindings: this.sortedBindings().map(binding => this.cloneBinding(binding)),
    };
  }

  private sortedProfileSelections(): TerminalShortcutProfileSelection[] {
    return [...this.profileSelections].sort((a, b) => {
      const scopeDelta = SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope);
      if (scopeDelta !== 0) return scopeDelta;
      return (a.workspaceId ?? a.sessionId ?? '').localeCompare(b.workspaceId ?? b.sessionId ?? '');
    });
  }

  private sortedBindings(): TerminalShortcutBinding[] {
    return [...this.bindings].sort((a, b) => {
      const scopeDelta = SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope);
      if (scopeDelta !== 0) return scopeDelta;
      const targetDelta = (a.workspaceId ?? a.sessionId ?? '').localeCompare(b.workspaceId ?? b.sessionId ?? '');
      if (targetDelta !== 0) return targetDelta;
      return a.sortOrder - b.sortOrder;
    });
  }

  private reindexScopeTarget(target: Pick<TerminalShortcutBinding, 'scope' | 'workspaceId' | 'sessionId'>): void {
    this.bindings
      .filter(item => this.isSameScopeTarget(item, target))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((item, index) => {
        item.sortOrder = index;
      });
  }

  private reindexAllBindings(target = this.bindings): void {
    const scopeKeys = new Set(target.map(binding => this.getScopeTargetKey(binding)));
    for (const scopeKey of scopeKeys) {
      target
        .filter(binding => this.getScopeTargetKey(binding) === scopeKey)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .forEach((binding, index) => {
          binding.sortOrder = index;
        });
    }
  }

  private isSameScopeTarget(
    left: { scope: TerminalShortcutScope; workspaceId?: string; sessionId?: string },
    right: { scope: TerminalShortcutScope; workspaceId?: string; sessionId?: string },
  ): boolean {
    return this.getScopeTargetKey(left) === this.getScopeTargetKey(right);
  }

  private getScopeTargetKey(target: { scope: TerminalShortcutScope; workspaceId?: string; sessionId?: string }): string {
    if (target.scope === 'workspace') {
      return `workspace:${target.workspaceId ?? ''}`;
    }
    if (target.scope === 'session') {
      return `session:${target.sessionId ?? ''}`;
    }
    return 'global';
  }

  private async runSerializedMutation<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const snapshot = this.cloneSnapshot();
      try {
        return await operation();
      } catch (error) {
        this.profileSelections = snapshot.profileSelections;
        this.bindings = snapshot.bindings;
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

  private cloneSnapshot(): TerminalShortcutStateSnapshot {
    return {
      profileSelections: this.profileSelections.map(selection => ({ ...selection })),
      bindings: this.bindings.map(binding => this.cloneBinding(binding)),
    };
  }

  private cloneBinding(binding: TerminalShortcutBinding): TerminalShortcutBinding {
    return {
      ...binding,
      action: { ...binding.action },
    };
  }

  private async flushToDisk(): Promise<void> {
    const file: TerminalShortcutState = {
      ...this.buildState(),
      lastUpdated: new Date().toISOString(),
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
      console.error('[TerminalShortcutService] Flush failed:', error.message);
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup failures.
      }
      throw new AppError(ErrorCode.CONFIG_PERSIST_FAILED, 'Failed to persist terminal shortcuts');
    }
  }
}
