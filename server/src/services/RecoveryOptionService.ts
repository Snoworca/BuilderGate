import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import type {
  CreateRecoveryOptionInput,
  RecoveryOption,
  RecoveryOptionDiagnostic,
  RecoveryOptionFile,
  RecoveryOptionIcon,
  UpdateRecoveryOptionInput,
} from '../types/recoveryOption.types.js';
import {
  getRecoveryExecutableToken,
  normalizeRecoveryExecutable,
  validateRecoveryArguments,
  validateRecoveryCommand,
} from '../utils/recoveryCommand.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface RecoveryOptionServiceOptions {
  dataPath?: string;
}

const DEFAULT_DATA_PATH = './data/recovery-options.json';
const MAX_TEXT_ICON_LENGTH = 4;
const BUILTIN_ICON_KEYS = new Set([
  'bot',
  'brain',
  'code',
  'sparkles',
  'terminal',
]);
const UNSAFE_TEXT_ICON_PATTERN = /<|>|javascript:|data:|https?:\/\/|url\s*\(|script|svg|on\w+\s*=|style\s*=/i;

export class RecoveryOptionService {
  private options: RecoveryOption[] = [];
  private diagnostics: RecoveryOptionDiagnostic[] = [];
  private readonly dataFilePath: string;
  private mutationChain: Promise<void> = Promise.resolve();

  // @req FR-AITUI-002
  constructor(options: RecoveryOptionServiceOptions = {}) {
    this.dataFilePath = path.resolve(options.dataPath ?? DEFAULT_DATA_PATH);
  }

  // @req REL-AITUI-001
  async initialize(): Promise<void> {
    this.diagnostics = [];
    await fs.mkdir(path.dirname(this.dataFilePath), { recursive: true });

    try {
      const diagnosticsBefore = this.diagnostics.length;
      this.options = await this.loadFromPath(this.dataFilePath);
      if (this.diagnostics.length !== diagnosticsBefore) {
        await this.flushToDisk();
      }
      return;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        this.options = this.createDefaultOptions();
        await this.flushToDisk();
        return;
      }

      this.recordDiagnostic('primary-load-failed', 'warning', `Recovery option primary store is corrupt or invalid: ${String(error?.message ?? error)}`);
      await this.recoverFromBackupOrDefaults();
    }
  }

  // @req FR-AITUI-002
  getAll(): RecoveryOption[] {
    return this.sortedOptions().map(option => this.cloneOption(option));
  }

  // @req FR-AITUI-002
  getDataFilePath(): string {
    return this.dataFilePath;
  }

  // @req REL-AITUI-001
  getDiagnostics(): RecoveryOptionDiagnostic[] {
    return this.diagnostics.map(diagnostic => ({ ...diagnostic }));
  }

  // @req FR-AITUI-003
  findEnabledBySubmittedCommand(commandLine: string): RecoveryOption | null {
    const executable = getRecoveryExecutableToken(commandLine);
    if (!executable) {
      return null;
    }
    const option = this.options.find(item => (
      item.enabled === true
      && normalizeRecoveryExecutable(item.command) === executable
    ));
    return option ? this.cloneOption(option) : null;
  }

  // @req FR-AITUI-004
  findEnabledById(id: string | undefined | null): RecoveryOption | null {
    if (!id) {
      return null;
    }
    const option = this.options.find(item => item.id === id && item.enabled === true);
    return option ? this.cloneOption(option) : null;
  }

  // @req FR-AITUI-002
  async createOption(input: CreateRecoveryOptionInput): Promise<RecoveryOption> {
    return this.runSerializedMutation(async () => {
      const command = validateRecoveryCommand(input.command);
      this.assertUniqueCommand(command);
      const now = new Date().toISOString();
      const option: RecoveryOption = {
        id: uuidv4(),
        command,
        arguments: validateRecoveryArguments(input.arguments),
        enabled: input.enabled === undefined ? true : this.validateEnabled(input.enabled),
        icon: this.validateIcon(input.icon),
        sortOrder: this.options.length,
        createdAt: now,
        updatedAt: now,
      };

      this.options.push(option);
      await this.flushToDisk();
      return this.cloneOption(option);
    });
  }

  // @req FR-AITUI-002
  async updateOption(id: string, input: UpdateRecoveryOptionInput): Promise<RecoveryOption> {
    return this.runSerializedMutation(async () => {
      const option = this.findOption(id);
      const command = input.command === undefined ? option.command : validateRecoveryCommand(input.command);
      if (command !== option.command) {
        this.assertUniqueCommand(command, id);
      }
      const args = input.arguments === undefined ? option.arguments : validateRecoveryArguments(input.arguments);
      const enabled = input.enabled === undefined ? option.enabled : this.validateEnabled(input.enabled);
      const icon = input.icon === undefined ? option.icon ?? null : this.validateIcon(input.icon);

      option.command = command;
      option.arguments = args;
      option.enabled = enabled;
      option.icon = icon;
      option.updatedAt = new Date().toISOString();
      await this.flushToDisk();
      return this.cloneOption(option);
    });
  }

  // @req FR-AITUI-002
  async deleteOption(id: string): Promise<void> {
    await this.runSerializedMutation(async () => {
      this.findOption(id);
      this.options = this.options.filter(option => option.id !== id);
      this.reindexAll();
      await this.flushToDisk();
    });
  }

  // @req FR-AITUI-002
  async reorderOptions(optionIds: unknown): Promise<void> {
    await this.runSerializedMutation(async () => {
      if (!Array.isArray(optionIds)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option order must be an array');
      }
      if (optionIds.some(id => typeof id !== 'string')) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option order contains an invalid option id');
      }
      const existingIds = new Set(this.options.map(option => option.id));
      const requestedIds = new Set(optionIds);
      if (optionIds.length !== this.options.length || requestedIds.size !== optionIds.length) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option order must include every option exactly once');
      }
      for (const id of optionIds) {
        if (!existingIds.has(id)) {
          throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option order contains an unknown option id');
        }
      }

      const order = new Map(optionIds.map((id, index) => [id, index]));
      for (const option of this.options) {
        option.sortOrder = order.get(option.id) ?? option.sortOrder;
        option.updatedAt = new Date().toISOString();
      }
      await this.flushToDisk();
    });
  }

  // @req REL-AITUI-001
  private async recoverFromBackupOrDefaults(): Promise<void> {
    const bakPath = `${this.dataFilePath}.bak`;
    try {
      this.options = await this.loadFromPath(bakPath);
      this.recordDiagnostic('backup-recovered', 'warning', 'Recovered recovery options from backup store');
      await this.flushToDisk({ preserveExistingBackup: true });
      return;
    } catch (error: any) {
      this.recordDiagnostic('backup-recovery-failed', 'warning', `Recovery option backup could not be recovered; restoring defaults: ${String(error?.message ?? error)}`);
      this.options = this.createDefaultOptions();
      await this.flushToDisk({ preserveExistingBackup: true });
    }
  }

  // @req REL-AITUI-001
  private async loadFromPath(filePath: string): Promise<RecoveryOption[]> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const file = JSON.parse(raw) as RecoveryOptionFile;
    if (file.version !== 1 || !Array.isArray(file.options)) {
      throw new Error('Invalid recovery option file format');
    }
    return this.sanitizeLoadedOptions(file.options);
  }

  // @req REL-AITUI-001
  private sanitizeLoadedOptions(options: RecoveryOption[]): RecoveryOption[] {
    const sanitized: RecoveryOption[] = [];
    const seenCommands = new Set<string>();
    const now = new Date().toISOString();

    for (const option of options) {
      try {
        const command = validateRecoveryCommand(option.command);
        const normalized = normalizeRecoveryExecutable(command);
        if (seenCommands.has(normalized)) {
          throw new AppError(ErrorCode.INVALID_INPUT, 'Duplicate recovery option command');
        }
        seenCommands.add(normalized);
        sanitized.push({
          id: typeof option.id === 'string' && option.id.trim() ? option.id : uuidv4(),
          command,
          arguments: validateRecoveryArguments(option.arguments),
          enabled: this.validateEnabled(option.enabled),
          icon: this.validateIcon(option.icon),
          sortOrder: Number.isFinite(option.sortOrder) ? option.sortOrder : sanitized.length,
          createdAt: typeof option.createdAt === 'string' ? option.createdAt : now,
          updatedAt: typeof option.updatedAt === 'string' ? option.updatedAt : now,
        });
      } catch (error) {
        this.recordDiagnostic(
          'invalid-row-dropped',
          'warning',
          `Invalid recovery option row dropped and quarantined in diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          this.describeUnsafeOption(option),
        );
      }
    }

    this.reindexAll(sanitized);
    return sanitized;
  }

  // @req FR-AITUI-005
  private createDefaultOptions(): RecoveryOption[] {
    const now = new Date().toISOString();
    return [
      {
        id: uuidv4(),
        command: 'claude',
        arguments: ['--continue'],
        enabled: true,
        icon: { type: 'builtin', key: 'bot' },
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: uuidv4(),
        command: 'codex',
        arguments: ['resume', '--last'],
        enabled: true,
        icon: { type: 'builtin', key: 'terminal' },
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  // @req FR-AITUI-002
  private sortedOptions(): RecoveryOption[] {
    return [...this.options].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // @req FR-AITUI-002
  private reindexAll(target = this.options): void {
    target
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((option, index) => {
        option.sortOrder = index;
      });
  }

  // @req FR-AITUI-002
  private findOption(id: string): RecoveryOption {
    const option = this.options.find(item => item.id === id);
    if (!option) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option not found');
    }
    return option;
  }

  // @req FR-AITUI-002
  private assertUniqueCommand(command: string, exceptId?: string): void {
    const normalized = normalizeRecoveryExecutable(command);
    const duplicate = this.options.some(option => option.id !== exceptId && normalizeRecoveryExecutable(option.command) === normalized);
    if (duplicate) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option command already exists');
    }
  }

  // @req SEC-AITUI-001
  private validateEnabled(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option enabled must be a boolean');
    }
    return value;
  }

  // @req SEC-AITUI-002
  private validateIcon(icon: unknown): RecoveryOptionIcon | null {
    if (icon === undefined || icon === null) {
      return null;
    }
    if (typeof icon !== 'object' || Array.isArray(icon)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option icon is invalid');
    }

    const candidate = icon as Partial<RecoveryOptionIcon>;
    if (candidate.type === 'builtin') {
      if (typeof candidate.key !== 'string' || !BUILTIN_ICON_KEYS.has(candidate.key)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option builtin icon is unsupported');
      }
      return { type: 'builtin', key: candidate.key };
    }

    if (candidate.type === 'text') {
      if (
        typeof candidate.value !== 'string'
        || !candidate.value.trim()
        || candidate.value.length > MAX_TEXT_ICON_LENGTH
        || UNSAFE_TEXT_ICON_PATTERN.test(candidate.value)
      ) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option text icon is unsafe');
      }
      return { type: 'text', value: candidate.value };
    }

    throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option icon type is unsupported');
  }

  // @req REL-AITUI-001
  private async runSerializedMutation<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const snapshot = this.cloneOptions(this.options);
      try {
        return await operation();
      } catch (error) {
        this.options = snapshot;
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

  // @req REL-AITUI-001
  private cloneOptions(options: RecoveryOption[]): RecoveryOption[] {
    return options.map(option => this.cloneOption(option));
  }

  // @req REL-AITUI-001
  private cloneOption(option: RecoveryOption): RecoveryOption {
    return {
      ...option,
      arguments: [...option.arguments],
      icon: option.icon ? { ...option.icon } : null,
    };
  }

  // @req REL-AITUI-001
  private recordDiagnostic(
    code: string,
    level: RecoveryOptionDiagnostic['level'],
    message: string,
    extra: Pick<RecoveryOptionDiagnostic, 'optionId' | 'command'> = {},
  ): void {
    this.diagnostics.push({ code, level, message, ...extra });
    console.warn(`[RecoveryOptionService] ${message}`);
  }

  // @req REL-AITUI-001
  private describeUnsafeOption(option: unknown): Pick<RecoveryOptionDiagnostic, 'optionId' | 'command'> {
    if (!option || typeof option !== 'object') {
      return {};
    }
    const record = option as Partial<RecoveryOption>;
    return {
      optionId: typeof record.id === 'string' ? record.id : undefined,
      command: typeof record.command === 'string' ? record.command : undefined,
    };
  }

  // @req REL-AITUI-001
  private async flushToDisk(options: { preserveExistingBackup?: boolean } = {}): Promise<void> {
    const file: RecoveryOptionFile = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      options: this.sortedOptions(),
    };
    const tmpPath = `${this.dataFilePath}.tmp`;
    const bakPath = `${this.dataFilePath}.bak`;

    try {
      await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
      if (!options.preserveExistingBackup) {
        try {
          await fs.copyFile(this.dataFilePath, bakPath);
        } catch {
          // No existing primary store to back up.
        }
      }
      await fs.rename(tmpPath, this.dataFilePath);
    } catch (error: any) {
      console.error('[RecoveryOptionService] Flush failed:', error.message);
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup failures.
      }
      throw new AppError(ErrorCode.CONFIG_PERSIST_FAILED, 'Failed to persist recovery options');
    }
  }
}
