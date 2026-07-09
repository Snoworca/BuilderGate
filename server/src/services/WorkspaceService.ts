import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import type {
  Workspace,
  WorkspaceTab,
  GridLayout,
  MoveTabResult,
  WorkspaceState,
  WorkspaceFile,
  WorkspaceTabCleanupStatus,
  WorkspaceTabLifecycleReason,
  WorkspaceTabLifecycleState,
} from '../types/workspace.types.js';
import type { RecoveryOption, RecoveryOptionIcon } from '../types/recoveryOption.types.js';
import type { ShellType } from '../types/index.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { config } from '../utils/config.js';
import { isDefaultTerminalTabName, isSystemAbsolutePathTerminalTitle, sanitizeTerminalTitle } from '../utils/terminalTitle.js';
import { buildRecoveryRestoreInput, getRecoveryExecutableToken, normalizeRecoveryExecutable, type RecoveryRestoreShell } from '../utils/recoveryCommand.js';
import type { SessionCommandSubmittedEvent, SessionFinalizedEvent, SessionManager } from './SessionManager.js';
import type { RecoveryOptionService } from './RecoveryOptionService.js';
import {
  createMcpSessionBinding,
  createStableSessionKey,
  listMcpSessions as listMcpSessionBindings,
  searchMcpSessions as searchMcpSessionBindings,
  setMcpSessionAlias as applyMcpSessionAlias,
  type McpSessionBinding,
  type SearchMcpSessionsResult,
} from './McpSessionRegistryContract.js';

interface WorkspaceConfig {
  dataPath: string;
  maxWorkspaces: number;
  maxTabsPerWorkspace: number;
  maxTotalSessions: number;
  flushDebounceMs: number;
  terminalTitleDebounceMs: number;
}

interface WorkspaceServiceOptions {
  terminalTitleDebounceMs?: number;
  recoveryOptionService?: RecoveryOptionService;
  restoreInputDelayMs?: number;
}

interface TabUpdatedEvent {
  tab: WorkspaceTab;
  changes: WorkspaceTabChanges;
}

type WorkspaceTabChanges = Partial<Omit<
  WorkspaceTab,
  'recoveryOptionId' | 'recoveryCommand' | 'recoveryArguments' | 'recoveryIcon' | 'recoveryUpdatedAt'
>> & {
  recoveryOptionId?: string | null;
  recoveryCommand?: string | null;
  recoveryArguments?: string[] | null;
  recoveryIcon?: RecoveryOptionIcon | null;
  recoveryUpdatedAt?: string | null;
};

interface WorkspaceSessionStoppedEvent {
  sessionId: string;
  reason: WorkspaceTabLifecycleReason;
  cleanupStatus: WorkspaceTabCleanupStatus;
  exitCode: number | null;
  recordedAt: string;
}

type WorkspaceTabLifecycleSnapshot = Pick<
  WorkspaceTab,
  'lifecycleState'
  | 'recoverable'
  | 'lifecycleReason'
  | 'cleanupStatus'
  | 'lastExitCode'
  | 'lifecycleUpdatedAt'
>;

export class WorkspaceService {
  private state: WorkspaceState = { workspaces: [], tabs: [], gridLayouts: [] };
  private config: WorkspaceConfig;
  private dataFilePath: string;
  private sessionManager: SessionManager;
  private recoveryOptionService: RecoveryOptionService | null;
  private restoreInputDelayMs: number;
  private pendingTerminalTitles = new Map<string, { title: string; timer: NodeJS.Timeout }>();
  private tabUpdatedCallback: ((event: TabUpdatedEvent) => void) | null = null;

  constructor(sessionManager: SessionManager, options: WorkspaceServiceOptions = {}) {
    this.sessionManager = sessionManager;
    this.recoveryOptionService = options.recoveryOptionService ?? null;
    const wsConfig = (config as any).workspace;
    this.config = {
      dataPath: wsConfig?.dataPath ?? './data/workspaces.json',
      maxWorkspaces: wsConfig?.maxWorkspaces ?? 10,
      maxTabsPerWorkspace: wsConfig?.maxTabsPerWorkspace ?? 8,
      maxTotalSessions: wsConfig?.maxTotalSessions ?? 32,
      flushDebounceMs: wsConfig?.flushDebounceMs ?? 5000,
      terminalTitleDebounceMs: options.terminalTitleDebounceMs ?? wsConfig?.terminalTitleDebounceMs ?? 250,
    };
    this.restoreInputDelayMs = Math.max(0, options.restoreInputDelayMs ?? wsConfig?.restoreInputDelayMs ?? 600);
    this.dataFilePath = path.resolve(this.config.dataPath);

    // Register CWD change callback to persist lastCwd to tab metadata
    this.sessionManager.onCwdChange((sessionId: string, cwd: string) => {
      const tab = this.state.tabs.find(t => t.sessionId === sessionId);
      if (tab) {
        tab.lastCwd = cwd;
        this.save();
      }
    });

    this.sessionManager.onTerminalTitleChange((sessionId: string, title: string) => {
      this.applyTerminalTitle(sessionId, title).catch((error) => {
        console.warn('[WorkspaceService] Failed to apply terminal title:', error);
      });
    });

    this.sessionManager.onSessionFinalized((event: SessionFinalizedEvent) => {
      if (!this.shouldPersistSessionFinalization(event.reason)) {
        return;
      }
      this.markSessionFinalized(event).catch((error) => {
        console.warn('[WorkspaceService] Failed to apply session lifecycle finalization:', error);
      });
    });

    const commandSubmissionSource = this.sessionManager as SessionManager & {
      onCommandSubmitted?: (cb: (event: SessionCommandSubmittedEvent) => void | Promise<void>) => void;
    };
    if (typeof commandSubmissionSource.onCommandSubmitted === 'function') {
      commandSubmissionSource.onCommandSubmitted((event: SessionCommandSubmittedEvent) => {
        this.applySubmittedRecoveryCommand(event).catch((error) => {
          console.warn('[WorkspaceService] Failed to apply recovery command metadata:', error);
        });
      });
    }
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dataFilePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      const raw = await fs.readFile(this.dataFilePath, 'utf-8');
      const file: WorkspaceFile = JSON.parse(raw);
      if (file.version === 1 && file.state) {
        this.state = file.state;
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // First run — create default workspace
        this.state = this.createDefaultState();
        await this.flushToDisk();
      } else {
        // JSON parse error — try backup
        console.warn('[WorkspaceService] Failed to load workspaces.json:', err.message);
        const bakPath = this.dataFilePath + '.bak';
        try {
          const bakRaw = await fs.readFile(bakPath, 'utf-8');
          const bakFile: WorkspaceFile = JSON.parse(bakRaw);
          if (bakFile.version === 1 && bakFile.state) {
            this.state = bakFile.state;
            console.log('[WorkspaceService] Recovered from backup');
            await this.flushToDisk();
          } else {
            throw new Error('Invalid backup format');
          }
        } catch {
          console.warn('[WorkspaceService] Backup also failed, starting fresh');
          this.state = this.createDefaultState();
          await this.flushToDisk();
        }
      }
    }

    // Sanitize lastCwd values loaded from disk (reject control characters)
    let tabMetadataChanged = false;
    for (const tab of this.state.tabs) {
      if (tab.lastCwd && /[\x00-\x1f]/.test(tab.lastCwd)) {
        tab.lastCwd = undefined;
      }
      this.normalizeTabNameMetadata(tab);
      this.normalizeTabLifecycleMetadata(tab);
      this.normalizeTabRecoveryMetadata(tab);
      tabMetadataChanged = this.ensureMcpTabBinding(tab) || tabMetadataChanged;
    }
    tabMetadataChanged = this.ensureUniqueMcpSessionKeys() || tabMetadataChanged;

    // Migrate legacy GridLayout (columns/rows/cellSizes → mosaicTree)
    this.migrateGridLayouts();

    // Ensure at least one workspace exists
    if (this.state.workspaces.length === 0) {
      this.state = this.createDefaultState();
      await this.save();
    } else if (tabMetadataChanged) {
      await this.save(true);
    }
  }

  // ============================================================================
  // Getters
  // ============================================================================

  getState(): WorkspaceState {
    return this.state;
  }

  getDataFilePath(): string {
    return this.dataFilePath;
  }

  getWorkspace(id: string): Workspace {
    const ws = this.state.workspaces.find(w => w.id === id);
    if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND);
    return ws;
  }

  getWorkspaceTabs(workspaceId: string): WorkspaceTab[] {
    return this.state.tabs.filter(t => t.workspaceId === workspaceId);
  }

  getTab(tabId: string): WorkspaceTab {
    const tab = this.state.tabs.find(t => t.id === tabId);
    if (!tab) throw new AppError(ErrorCode.TAB_NOT_FOUND);
    return tab;
  }

  // @req FR-MCP-006
  listMcpSessions(actorSessionKey?: string, includeSelf = false): Array<Record<string, unknown>> {
    return listMcpSessionBindings({
      actorSessionKey,
      includeSelf,
      registry: this.getMcpSessionRegistry(),
    }).sessions;
  }

  // @req FR-MCP-006
  searchMcpSessions(actorSessionKey: string | undefined, query: string, includeSelf = false): SearchMcpSessionsResult {
    return searchMcpSessionBindings({
      actorSessionKey,
      query,
      includeSelf,
      registry: this.getMcpSessionRegistry(),
    });
  }

  // @req FR-MCP-006
  async setMcpSessionAlias(targetSessionKey: string, alias: string, actorSessionKey?: string): Promise<WorkspaceTab> {
    const result = applyMcpSessionAlias({
      actorSessionKey,
      targetSessionKey,
      alias,
      registry: this.getMcpSessionRegistry(),
    });
    if (result.allowed === false) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }

    const tab = this.state.tabs.find(item => item.sessionKey === targetSessionKey);
    if (!tab) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }
    const binding = result.binding as McpSessionBinding;
    this.cancelPendingTerminalTitle(tab.sessionId);
    tab.name = binding.alias;
    tab.nameSource = 'user';
    delete tab.terminalTitle;
    await this.save();
    this.emitTabUpdated({
      tab,
      changes: {
        name: tab.name,
        nameSource: tab.nameSource,
        terminalTitle: undefined,
        sessionKey: tab.sessionKey,
        currentSessionId: tab.currentSessionId,
      },
    });
    return tab;
  }

  getGridLayout(workspaceId: string): GridLayout | undefined {
    return this.state.gridLayouts.find(g => g.workspaceId === workspaceId);
  }

  // ============================================================================
  // Workspace CRUD
  // ============================================================================

  async createWorkspace(name?: string): Promise<Workspace> {
    if (this.state.workspaces.length >= this.config.maxWorkspaces) {
      throw new AppError(ErrorCode.WORKSPACE_LIMIT_EXCEEDED);
    }

    const trimmedName = (name || `Workspace-${this.state.workspaces.length + 1}`).trim();
    if (!trimmedName || trimmedName.length > 32) {
      throw new AppError(ErrorCode.INVALID_NAME);
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: uuidv4(),
      name: trimmedName,
      sortOrder: this.state.workspaces.length,
      viewMode: 'tab',
      activeTabId: null,
      colorCounter: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.state.workspaces.push(workspace);
    await this.save(true);
    return workspace;
  }

  async updateWorkspace(id: string, updates: Partial<Pick<Workspace, 'name' | 'viewMode' | 'activeTabId'>>): Promise<Workspace> {
    const ws = this.getWorkspace(id);

    if (updates.name !== undefined) {
      const trimmedName = updates.name.trim();
      if (!trimmedName || trimmedName.length > 32) {
        throw new AppError(ErrorCode.INVALID_NAME);
      }
      ws.name = trimmedName;
    }
    if (updates.viewMode !== undefined) ws.viewMode = updates.viewMode;
    if (updates.activeTabId !== undefined) ws.activeTabId = updates.activeTabId;
    ws.updatedAt = new Date().toISOString();

    await this.save();
    return ws;
  }

  async deleteWorkspace(id: string): Promise<void> {
    if (this.state.workspaces.length <= 1) {
      throw new AppError(ErrorCode.LAST_WORKSPACE);
    }

    this.getWorkspace(id); // throws if not found

    // Terminate all PTY sessions in this workspace
    const tabs = this.getWorkspaceTabs(id);
    const sessionIds = tabs.map(t => t.sessionId);
    for (const sessionId of sessionIds) {
      this.cancelPendingTerminalTitle(sessionId);
    }
    const lifecycleSnapshots = new Map<string, WorkspaceTabLifecycleSnapshot>();
    for (const tab of tabs) {
      lifecycleSnapshots.set(tab.id, this.snapshotTabLifecycle(tab));
      this.markTabStopped(tab, 'workspace-delete', {
        cleanupStatus: 'not-started',
        exitCode: null,
      });
    }
    try {
      await this.save(true);
    } catch (error) {
      for (const tab of tabs) {
        const snapshot = lifecycleSnapshots.get(tab.id);
        if (snapshot) {
          this.restoreTabLifecycle(tab, snapshot);
        }
      }
      throw error;
    }
    await this.sessionManager.terminateMultipleSessions(sessionIds, { reason: 'workspace-delete' });

    // Remove tabs, grid layouts, and workspace
    this.state.tabs = this.state.tabs.filter(t => t.workspaceId !== id);
    this.state.gridLayouts = this.state.gridLayouts.filter(g => g.workspaceId !== id);
    this.state.workspaces = this.state.workspaces.filter(w => w.id !== id);

    await this.save(true);
  }

  async reorderWorkspaces(workspaceIds: string[]): Promise<void> {
    this.validateExactIdSet(
      workspaceIds,
      this.state.workspaces.map(workspace => workspace.id),
    );
    for (let i = 0; i < workspaceIds.length; i++) {
      const ws = this.state.workspaces.find(w => w.id === workspaceIds[i]);
      if (ws) ws.sortOrder = i;
    }
    await this.save();
  }

  // ============================================================================
  // Tab CRUD
  // ============================================================================

  async addTab(workspaceId: string, shell?: ShellType, name?: string, cwd?: string): Promise<WorkspaceTab> {
    const ws = this.getWorkspace(workspaceId);
    const wsTabs = this.getWorkspaceTabs(workspaceId);

    if (wsTabs.length >= this.config.maxTabsPerWorkspace) {
      throw new AppError(ErrorCode.TAB_LIMIT_EXCEEDED);
    }

    if (this.state.tabs.length >= this.config.maxTotalSessions) {
      throw new AppError(ErrorCode.SESSION_LIMIT_EXCEEDED);
    }

    // Create PTY session
    const shellType = shell || 'auto';
    const sessionDTO = this.sessionManager.createSession(
      name || `Terminal-${wsTabs.length + 1}`,
      shellType,
      cwd
    );

    const colorIndex = ws.colorCounter % 8;
    ws.colorCounter++;

    const tab: WorkspaceTab = {
      id: uuidv4(),
      workspaceId,
      sessionId: sessionDTO.id,
      sessionKey: createStableSessionKey(),
      currentSessionId: sessionDTO.id,
      previousSessionIds: [],
      name: name || `Terminal-${wsTabs.length + 1}`,
      nameSource: name ? 'user' : 'default',
      colorIndex,
      sortOrder: wsTabs.length,
      shellType,
      createdAt: new Date().toISOString(),
      lifecycleState: 'active',
      recoverable: true,
      cleanupStatus: 'not-started',
      lastExitCode: null,
      lifecycleUpdatedAt: new Date().toISOString(),
      generation: 1,
    };

    this.state.tabs.push(tab);

    // Auto-activate first tab
    if (ws.activeTabId === null) {
      ws.activeTabId = tab.id;
    }

    ws.updatedAt = new Date().toISOString();
    await this.save(true);
    return tab;
  }

  async updateTab(tabId: string, updates: { name?: string }): Promise<WorkspaceTab> {
    const tab = this.getTab(tabId);

    if (updates.name !== undefined) {
      const trimmedName = updates.name.trim();
      if (!trimmedName || trimmedName.length > 32) {
        throw new AppError(ErrorCode.INVALID_NAME);
      }
      this.cancelPendingTerminalTitle(tab.sessionId);
      tab.name = trimmedName;
      tab.nameSource = 'user';
      delete tab.terminalTitle;
    }

    await this.save();
    return tab;
  }

  async deleteTab(workspaceId: string, tabId: string): Promise<void> {
    const tab = this.getTab(tabId);
    if (tab.workspaceId !== workspaceId) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }

    this.cancelPendingTerminalTitle(tab.sessionId);

    const lifecycleSnapshot = this.snapshotTabLifecycle(tab);
    try {
      this.markTabStopped(tab, 'tab-delete', {
        cleanupStatus: 'not-started',
        exitCode: null,
      });
      await this.save(true);
    } catch (error) {
      this.restoreTabLifecycle(tab, lifecycleSnapshot);
      throw error;
    }

    // Terminate PTY session after the non-recoverable marker is durable.
    await this.sessionManager.terminateSession(tab.sessionId, { reason: 'tab-delete' });

    // Remove tab
    this.state.tabs = this.state.tabs.filter(t => t.id !== tabId);

    // Update active tab if needed
    const ws = this.getWorkspace(workspaceId);
    if (ws.activeTabId === tabId) {
      const remaining = this.getWorkspaceTabs(workspaceId);
      ws.activeTabId = remaining.length > 0 ? remaining[0].id : null;
    }

    ws.updatedAt = new Date().toISOString();
    await this.save(true);
  }

  async reorderTabs(workspaceId: string, tabIds: string[]): Promise<void> {
    this.getWorkspace(workspaceId);
    this.validateExactIdSet(
      tabIds,
      this.getWorkspaceTabs(workspaceId).map(tab => tab.id),
    );
    for (let i = 0; i < tabIds.length; i++) {
      const tab = this.state.tabs.find(t => t.id === tabIds[i] && t.workspaceId === workspaceId);
      if (tab) tab.sortOrder = i;
    }
    await this.save();
  }

  async moveTab(sourceWorkspaceId: string, tabId: string, targetWorkspaceId: string): Promise<MoveTabResult> {
    if (sourceWorkspaceId === targetWorkspaceId) {
      throw new AppError(ErrorCode.INVALID_WORKSPACE_MOVE);
    }

    const sourceWorkspace = this.getWorkspace(sourceWorkspaceId);
    const targetWorkspace = this.getWorkspace(targetWorkspaceId);
    const tab = this.getTab(tabId);
    if (tab.workspaceId !== sourceWorkspaceId) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }

    if (this.getWorkspaceTabs(targetWorkspaceId).length >= this.config.maxTabsPerWorkspace) {
      throw new AppError(ErrorCode.TAB_LIMIT_EXCEEDED);
    }

    if (!this.isMovableTab(tab)) {
      throw new AppError(ErrorCode.SESSION_NOT_MOVABLE);
    }

    const snapshot = this.cloneState(this.state);

    try {
      const sourceTabs = this.sortTabs(
        this.getWorkspaceTabs(sourceWorkspaceId).filter(sourceTab => sourceTab.id !== tabId),
      );
      const targetTabs = [
        ...this.sortTabs(this.getWorkspaceTabs(targetWorkspaceId)),
        tab,
      ];

      tab.workspaceId = targetWorkspaceId;

      sourceTabs.forEach((sourceTab, index) => {
        sourceTab.sortOrder = index;
      });

      targetTabs.forEach((targetTab, index) => {
        targetTab.sortOrder = index;
      });

      if (sourceWorkspace.activeTabId === tabId) {
        sourceWorkspace.activeTabId = sourceTabs[0]?.id ?? null;
      }
      targetWorkspace.activeTabId = tabId;

      const updatedAt = new Date().toISOString();
      sourceWorkspace.updatedAt = updatedAt;
      targetWorkspace.updatedAt = updatedAt;

      await this.save();

      return {
        tab,
        sourceWorkspaceId,
        targetWorkspaceId,
        sourceActiveTabId: sourceWorkspace.activeTabId,
        targetActiveTabId: targetWorkspace.activeTabId,
        sourceTabIds: sourceTabs.map(sourceTab => sourceTab.id),
        targetTabIds: targetTabs.map(targetTab => targetTab.id),
      };
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async restartTab(workspaceId: string, tabId: string): Promise<WorkspaceTab> {
    const tab = this.getTab(tabId);
    if (tab.workspaceId !== workspaceId) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }

    const oldSessionId = tab.sessionId;
    this.cancelPendingTerminalTitle(oldSessionId);
    const previousTabState: Partial<WorkspaceTab> = {
      sessionId: tab.sessionId,
      sessionKey: tab.sessionKey,
      currentSessionId: tab.currentSessionId,
      previousSessionIds: tab.previousSessionIds ? [...tab.previousSessionIds] : undefined,
      lifecycleState: tab.lifecycleState,
      recoverable: tab.recoverable,
      lifecycleReason: tab.lifecycleReason,
      cleanupStatus: tab.cleanupStatus,
      lastExitCode: tab.lastExitCode,
      lifecycleUpdatedAt: tab.lifecycleUpdatedAt,
      generation: tab.generation,
      generationReason: tab.generationReason,
    };

    // Create new PTY session with same shell type, restoring last CWD
    const sessionDTO = this.sessionManager.createSession(tab.name, tab.shellType, tab.lastCwd);
    tab.sessionId = sessionDTO.id;
    this.bindCurrentSessionId(tab, sessionDTO.id, oldSessionId);
    this.markTabActive(tab, 'tab-restart');

    try {
      await this.save(true);
    } catch (error) {
      Object.assign(tab, previousTabState);
      try {
        await this.sessionManager.terminateSession(sessionDTO.id, { reason: 'tab-restart' });
      } catch (cleanupError) {
        console.warn('[WorkspaceService] Failed to terminate replacement session after restart save failure:', cleanupError);
      }
      throw error;
    }
    await this.scheduleRecoveryRestoreForTab(tab, sessionDTO.id);
    await this.sessionManager.terminateSession(oldSessionId, { reason: 'tab-restart' });
    return tab;
  }

  async markSessionStoppedByDirectDelete(sessionId: string): Promise<boolean> {
    const existing = this.state.tabs.find(t => t.sessionId === sessionId);
    if (
      existing?.lifecycleState === 'stopped'
      && existing.recoverable === false
      && existing.lifecycleReason === 'direct-session-delete'
    ) {
      await this.save(true);
      return true;
    }

    return this.markSessionLifecycleStopped({
      sessionId,
      reason: 'direct-session-delete',
      cleanupStatus: 'not-started',
      exitCode: null,
      recordedAt: new Date().toISOString(),
    });
  }

  async markSessionFinalized(event: SessionFinalizedEvent): Promise<boolean> {
    return this.markSessionLifecycleStopped({
      sessionId: event.sessionId,
      reason: this.toWorkspaceLifecycleReason(event.reason),
      cleanupStatus: this.toWorkspaceCleanupStatus(event.cleanupStatus),
      exitCode: event.exitCode,
      recordedAt: event.recordedAt,
    });
  }

  async applySubmittedRecoveryCommand(event: SessionCommandSubmittedEvent): Promise<void> {
    if (!this.recoveryOptionService) {
      return;
    }
    const tab = this.state.tabs.find(t => t.sessionId === event.sessionId);
    if (!tab) {
      return;
    }

    const option = this.recoveryOptionService.findEnabledBySubmittedCommand(event.command);
    if (!option) {
      if (!this.hasRecoveryMetadata(tab)) {
        return;
      }
      this.clearTabRecoveryMetadata(tab);
      await this.save(true);
      this.emitTabUpdated({ tab, changes: this.recoveryChanges(tab, true) });
      return;
    }

    this.setTabRecoveryMetadata(tab, option);
    this.markRecoveryForegroundCommand(event.sessionId, option.command);
    await this.save(true);
    this.emitTabUpdated({ tab, changes: this.recoveryChanges(tab) });
  }

  async applyRecoveryOptionToTabs(option: RecoveryOption): Promise<void> {
    const changedTabs: Array<{ tab: WorkspaceTab; cleared: boolean }> = [];
    for (const tab of this.state.tabs) {
      if (tab.recoveryOptionId !== option.id) {
        continue;
      }
      if (option.enabled) {
        this.setTabRecoveryMetadata(tab, option);
        changedTabs.push({ tab, cleared: false });
      } else {
        this.clearTabRecoveryMetadata(tab);
        changedTabs.push({ tab, cleared: true });
      }
    }
    if (changedTabs.length === 0) {
      return;
    }

    await this.save(true);
    for (const event of changedTabs) {
      this.emitTabUpdated({
        tab: event.tab,
        changes: this.recoveryChanges(event.tab, event.cleared),
      });
    }
  }

  async clearRecoveryMetadataForOption(optionId: string): Promise<void> {
    const changedTabs: WorkspaceTab[] = [];
    for (const tab of this.state.tabs) {
      if (tab.recoveryOptionId !== optionId) {
        continue;
      }
      this.clearTabRecoveryMetadata(tab);
      changedTabs.push(tab);
    }
    if (changedTabs.length === 0) {
      return;
    }

    await this.save(true);
    for (const tab of changedTabs) {
      this.emitTabUpdated({ tab, changes: this.recoveryChanges(tab, true) });
    }
  }

  onTabUpdated(cb: (event: TabUpdatedEvent) => void): void {
    this.tabUpdatedCallback = cb;
  }

  async applyTerminalTitle(sessionId: string, rawTitle: string): Promise<void> {
    const title = sanitizeTerminalTitle(rawTitle);
    if (!title) {
      return;
    }

    this.cancelPendingTerminalTitle(sessionId);

    if (isSystemAbsolutePathTerminalTitle(title)) {
      return;
    }

    if (!this.isTerminalTitleEligible(sessionId)) {
      return;
    }

    if (this.config.terminalTitleDebounceMs <= 0) {
      await this.commitTerminalTitle(sessionId, title);
      return;
    }

    const pending = {
      title,
      timer: setTimeout(() => {
        if (this.pendingTerminalTitles.get(sessionId) !== pending) {
          return;
        }
        this.pendingTerminalTitles.delete(sessionId);
        this.commitTerminalTitle(sessionId, title).catch((error) => {
          console.warn('[WorkspaceService] Failed to commit terminal title:', error);
        });
      }, this.config.terminalTitleDebounceMs),
    };
    this.pendingTerminalTitles.set(sessionId, pending);
  }

  // ============================================================================
  // Grid Layout
  // ============================================================================

  async updateGridLayout(workspaceId: string, layout: Omit<GridLayout, 'workspaceId'>): Promise<GridLayout> {
    this.getWorkspace(workspaceId); // validate existence

    const existing = this.state.gridLayouts.findIndex(g => g.workspaceId === workspaceId);
    const gridLayout: GridLayout = { workspaceId, ...layout };

    if (existing >= 0) {
      this.state.gridLayouts[existing] = gridLayout;
    } else {
      this.state.gridLayouts.push(gridLayout);
    }

    await this.save();
    return gridLayout;
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private validateExactIdSet(actualIds: string[], expectedIds: string[]): void {
    if (!Array.isArray(actualIds) || actualIds.length !== expectedIds.length) {
      throw new AppError(ErrorCode.INVALID_REORDER_PAYLOAD);
    }

    const expected = new Set(expectedIds);
    const actual = new Set(actualIds);
    if (actual.size !== actualIds.length || actual.size !== expected.size) {
      throw new AppError(ErrorCode.INVALID_REORDER_PAYLOAD);
    }

    for (const id of actual) {
      if (!expected.has(id)) {
        throw new AppError(ErrorCode.INVALID_REORDER_PAYLOAD);
      }
    }
  }

  private sortTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
    return [...tabs].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private isMovableTab(tab: WorkspaceTab): boolean {
    if (tab.lifecycleState === 'stopped') {
      return false;
    }
    if (tab.recoverable === false) {
      return false;
    }
    if (!this.sessionManager.hasSession(tab.sessionId)) {
      return false;
    }
    return true;
  }

  private cloneState(state: WorkspaceState): WorkspaceState {
    return JSON.parse(JSON.stringify(state)) as WorkspaceState;
  }

  // @req FR-MCP-001
  private getMcpSessionRegistry(): McpSessionBinding[] {
    this.ensureUniqueMcpSessionKeys();
    return this.sortTabs(this.state.tabs)
      .filter(tab => tab.lifecycleState !== 'stopped' && this.sessionManager.hasSession(tab.sessionId))
      .map(tab => {
        this.ensureMcpTabBinding(tab);
        return createMcpSessionBinding({ tab });
      });
  }

  // @req FR-MCP-001
  private ensureMcpTabBinding(tab: WorkspaceTab): boolean {
    let changed = false;
    if (!tab.sessionKey || tab.sessionKey.trim() === '' || tab.sessionKey === tab.sessionId) {
      tab.sessionKey = createStableSessionKey(tab.id);
      changed = true;
    }
    if (!tab.currentSessionId || tab.currentSessionId.trim() === '') {
      tab.currentSessionId = tab.sessionId;
      changed = true;
    }
    const previous = this.normalizePreviousSessionIds(tab.previousSessionIds, tab.currentSessionId);
    if (JSON.stringify(previous) !== JSON.stringify(tab.previousSessionIds ?? [])) {
      tab.previousSessionIds = previous;
      changed = true;
    } else if (!tab.previousSessionIds) {
      tab.previousSessionIds = [];
      changed = true;
    }
    return changed;
  }

  // @req FR-MCP-001
  private bindCurrentSessionId(tab: WorkspaceTab, nextSessionId: string, previousSessionId: string): void {
    this.ensureMcpTabBinding(tab);
    const priorCurrentSessionId = tab.currentSessionId || previousSessionId;
    const previous = this.normalizePreviousSessionIds(tab.previousSessionIds, nextSessionId);
    if (priorCurrentSessionId !== nextSessionId && !previous.includes(priorCurrentSessionId)) {
      previous.push(priorCurrentSessionId);
    }
    tab.currentSessionId = nextSessionId;
    tab.previousSessionIds = previous;
  }

  // @req FR-MCP-001
  private normalizePreviousSessionIds(value: readonly string[] | undefined, currentSessionId?: string): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of value) {
      if (typeof raw !== 'string') {
        continue;
      }
      const sessionId = raw.trim();
      if (!sessionId || sessionId === currentSessionId || seen.has(sessionId)) {
        continue;
      }
      seen.add(sessionId);
      result.push(sessionId);
    }
    return result;
  }

  // @req FR-MCP-006
  private ensureUniqueMcpSessionKeys(): boolean {
    const used = new Set<string>();
    let changed = false;

    for (const tab of this.sortTabs(this.state.tabs)) {
      changed = this.ensureMcpTabBinding(tab) || changed;
      const currentKey = tab.sessionKey;
      if (!currentKey) {
        continue;
      }
      if (!used.has(currentKey)) {
        used.add(currentKey);
        continue;
      }

      const replacement = this.createUniqueMcpSessionKey(tab, used);
      console.warn(`[WorkspaceService] Duplicate MCP sessionKey detected for tab ${tab.id}; regenerated stable key`);
      tab.sessionKey = replacement;
      used.add(replacement);
      changed = true;
    }

    return changed;
  }

  // @req FR-MCP-006
  private createUniqueMcpSessionKey(tab: WorkspaceTab, used: Set<string>): string {
    const preferred = createStableSessionKey(tab.id);
    if (!used.has(preferred)) {
      return preferred;
    }

    let candidate = createStableSessionKey();
    while (used.has(candidate)) {
      candidate = createStableSessionKey();
    }
    return candidate;
  }

  private async markSessionLifecycleStopped(event: WorkspaceSessionStoppedEvent): Promise<boolean> {
    const tab = this.state.tabs.find(t => t.sessionId === event.sessionId);
    if (!tab) {
      return false;
    }

    this.cancelPendingTerminalTitle(event.sessionId);
    const lifecycleSnapshot = this.snapshotTabLifecycle(tab);
    try {
      this.markTabStopped(tab, event.reason, {
        cleanupStatus: event.cleanupStatus,
        exitCode: event.exitCode,
        updatedAt: event.recordedAt,
      });
      await this.save(true);
    } catch (error) {
      this.restoreTabLifecycle(tab, lifecycleSnapshot);
      throw error;
    }
    this.emitTabUpdated({
      tab,
      changes: this.lifecycleChanges(tab),
    });
    return true;
  }

  private markTabActive(tab: WorkspaceTab, reason?: WorkspaceTabLifecycleReason): void {
    const updatedAt = new Date().toISOString();
    tab.lifecycleState = 'active';
    tab.recoverable = true;
    if (reason) {
      tab.lifecycleReason = reason;
    } else {
      delete tab.lifecycleReason;
    }
    tab.cleanupStatus = 'not-started';
    tab.lastExitCode = null;
    tab.lifecycleUpdatedAt = updatedAt;
    tab.generation = this.nextTabGeneration(tab);
    if (reason === 'tab-restart' || reason === 'orphan-recovery') {
      tab.generationReason = reason;
    } else {
      delete tab.generationReason;
    }
  }

  private markTabStopped(
    tab: WorkspaceTab,
    reason: WorkspaceTabLifecycleReason,
    options: {
      cleanupStatus: WorkspaceTabCleanupStatus;
      exitCode: number | null;
      updatedAt?: string;
    },
  ): void {
    tab.lifecycleState = 'stopped';
    tab.recoverable = false;
    tab.lifecycleReason = reason;
    tab.cleanupStatus = options.cleanupStatus;
    tab.lastExitCode = options.exitCode;
    tab.lifecycleUpdatedAt = options.updatedAt ?? new Date().toISOString();
  }

  private snapshotTabLifecycle(tab: WorkspaceTab): WorkspaceTabLifecycleSnapshot {
    return {
      lifecycleState: tab.lifecycleState,
      recoverable: tab.recoverable,
      lifecycleReason: tab.lifecycleReason,
      cleanupStatus: tab.cleanupStatus,
      lastExitCode: tab.lastExitCode,
      lifecycleUpdatedAt: tab.lifecycleUpdatedAt,
    };
  }

  private restoreTabLifecycle(tab: WorkspaceTab, snapshot: WorkspaceTabLifecycleSnapshot): void {
    if (snapshot.lifecycleState === undefined) {
      delete tab.lifecycleState;
    } else {
      tab.lifecycleState = snapshot.lifecycleState;
    }
    if (snapshot.recoverable === undefined) {
      delete tab.recoverable;
    } else {
      tab.recoverable = snapshot.recoverable;
    }
    if (snapshot.lifecycleReason === undefined) {
      delete tab.lifecycleReason;
    } else {
      tab.lifecycleReason = snapshot.lifecycleReason;
    }
    if (snapshot.cleanupStatus === undefined) {
      delete tab.cleanupStatus;
    } else {
      tab.cleanupStatus = snapshot.cleanupStatus;
    }
    if (snapshot.lastExitCode === undefined) {
      delete tab.lastExitCode;
    } else {
      tab.lastExitCode = snapshot.lastExitCode;
    }
    if (snapshot.lifecycleUpdatedAt === undefined) {
      delete tab.lifecycleUpdatedAt;
    } else {
      tab.lifecycleUpdatedAt = snapshot.lifecycleUpdatedAt;
    }
  }

  private nextTabGeneration(tab: WorkspaceTab): number {
    return Number.isInteger(tab.generation) && (tab.generation ?? 0) > 0
      ? (tab.generation as number) + 1
      : 1;
  }

  private isRecoverableOrphanTab(tab: WorkspaceTab): boolean {
    if (tab.lifecycleState === 'stopped') {
      return false;
    }
    if (tab.recoverable === false) {
      return false;
    }
    return true;
  }

  private lifecycleChanges(tab: WorkspaceTab): Partial<WorkspaceTab> {
    return {
      sessionId: tab.sessionId,
      lifecycleState: tab.lifecycleState,
      recoverable: tab.recoverable,
      lifecycleReason: tab.lifecycleReason,
      cleanupStatus: tab.cleanupStatus,
      lastExitCode: tab.lastExitCode,
      lifecycleUpdatedAt: tab.lifecycleUpdatedAt,
      generation: tab.generation,
    };
  }

  private setTabRecoveryMetadata(tab: WorkspaceTab, option: RecoveryOption): void {
    tab.recoveryOptionId = option.id;
    tab.recoveryCommand = option.command;
    tab.recoveryArguments = [...option.arguments];
    tab.recoveryIcon = this.cloneRecoveryIcon(option.icon ?? null);
    tab.recoveryUpdatedAt = new Date().toISOString();
  }

  private clearTabRecoveryMetadata(tab: WorkspaceTab): void {
    delete tab.recoveryOptionId;
    delete tab.recoveryCommand;
    delete tab.recoveryArguments;
    delete tab.recoveryIcon;
    delete tab.recoveryUpdatedAt;
  }

  private hasRecoveryMetadata(tab: WorkspaceTab): boolean {
    return Boolean(
      tab.recoveryOptionId
      || tab.recoveryCommand
      || tab.recoveryArguments
      || tab.recoveryIcon
      || tab.recoveryUpdatedAt,
    );
  }

  private recoveryChanges(tab: WorkspaceTab, cleared = false): WorkspaceTabChanges {
    if (cleared) {
      return {
        recoveryOptionId: null,
        recoveryCommand: null,
        recoveryArguments: null,
        recoveryIcon: null,
        recoveryUpdatedAt: null,
      };
    }
    return {
      recoveryOptionId: tab.recoveryOptionId,
      recoveryCommand: tab.recoveryCommand,
      recoveryArguments: tab.recoveryArguments ? [...tab.recoveryArguments] : undefined,
      recoveryIcon: this.cloneRecoveryIcon(tab.recoveryIcon ?? null),
      recoveryUpdatedAt: tab.recoveryUpdatedAt,
    };
  }

  private cloneRecoveryIcon(icon: RecoveryOptionIcon | null | undefined): RecoveryOptionIcon | null {
    if (!icon) {
      return null;
    }
    if (icon.type === 'builtin' && typeof icon.key === 'string') {
      return { type: 'builtin', key: icon.key };
    }
    if (icon.type === 'text' && typeof icon.value === 'string') {
      return { type: 'text', value: icon.value };
    }
    return null;
  }

  private markRecoveryForegroundCommand(sessionId: string, command: string): void {
    if (this.isBuiltInInteractiveCommand(command)) {
      return;
    }
    const foregroundMarker = (this.sessionManager as SessionManager & {
      markRecoveryCommandForeground?: (sessionId: string, command: string) => void;
    }).markRecoveryCommandForeground;
    if (typeof foregroundMarker === 'function') {
      foregroundMarker.call(this.sessionManager, sessionId, command);
    }
  }

  private isBuiltInInteractiveCommand(command: string): boolean {
    const executable = getRecoveryExecutableToken(command) ?? normalizeRecoveryExecutable(command);
    return executable === 'hermes'
      || executable === 'codex'
      || executable === 'claude'
      || executable === 'claude-code';
  }

  private async scheduleRecoveryRestoreForTab(tab: WorkspaceTab, sessionId: string): Promise<void> {
    if (!this.recoveryOptionService || !tab.recoveryOptionId) {
      return;
    }

    const option = this.recoveryOptionService.findEnabledById(tab.recoveryOptionId);
    if (!option) {
      this.clearTabRecoveryMetadata(tab);
      try {
        await this.save(true);
        this.emitTabUpdated({ tab, changes: this.recoveryChanges(tab, true) });
      } catch (error) {
        console.warn('[WorkspaceService] Failed to persist stale recovery metadata cleanup:', error);
      }
      return;
    }

    let input: string;
    try {
      input = buildRecoveryRestoreInput(
        this.resolveRecoveryRestoreShell(sessionId, tab.shellType),
        option.command,
        option.arguments,
      );
    } catch (error) {
      console.warn('[WorkspaceService] Failed to build recovery restore input:', error);
      return;
    }

    const scheduler = (this.sessionManager as SessionManager & {
      scheduleRestoreInput?: (
        sessionId: string,
        input: string,
        options?: { delayMs?: number; guard?: () => boolean },
      ) => void;
    }).scheduleRestoreInput;
    if (typeof scheduler !== 'function') {
      console.warn('[WorkspaceService] Recovery restore skipped because SessionManager does not support scheduled input');
      return;
    }

    scheduler.call(this.sessionManager, sessionId, input, {
      delayMs: this.restoreInputDelayMs,
      guard: () => this.state.tabs.some(current => current.id === tab.id && current.sessionId === sessionId),
    });
  }

  private resolveRecoveryRestoreShell(sessionId: string, fallbackShellType: ShellType): RecoveryRestoreShell {
    const resolver = (this.sessionManager as SessionManager & {
      getResolvedShellType?: (sessionId: string) => RecoveryRestoreShell | null;
    }).getResolvedShellType;
    const resolvedShell = typeof resolver === 'function'
      ? resolver.call(this.sessionManager, sessionId)
      : null;
    return resolvedShell ?? this.toRecoveryRestoreShell(fallbackShellType);
  }

  private toRecoveryRestoreShell(shellType: ShellType): RecoveryRestoreShell {
    switch (shellType) {
      case 'powershell':
      case 'wsl':
      case 'bash':
      case 'zsh':
      case 'sh':
      case 'cmd':
        return shellType;
      case 'auto':
      default:
        return 'auto';
    }
  }

  private toWorkspaceLifecycleReason(reason: SessionFinalizedEvent['reason']): WorkspaceTabLifecycleReason {
    switch (reason) {
      case 'tab-delete':
      case 'workspace-delete':
      case 'tab-restart':
      case 'direct-session-delete':
      case 'process-exit':
      case 'shutdown':
        return reason;
      default:
        return 'process-exit';
    }
  }

  private toWorkspaceCleanupStatus(status: SessionFinalizedEvent['cleanupStatus']): WorkspaceTabCleanupStatus {
    switch (status) {
      case 'observed':
      case 'completed':
      case 'degraded':
      case 'failed':
      case 'not-started':
        return status;
      case 'skipped-unverified':
      default:
        return 'degraded';
    }
  }

  private shouldPersistSessionFinalization(reason: SessionFinalizedEvent['reason']): boolean {
    return reason === 'process-exit' || reason === 'direct-session-delete';
  }

  private normalizeTabLifecycleMetadata(tab: WorkspaceTab): void {
    if (tab.lifecycleState !== undefined && tab.lifecycleState !== 'active' && tab.lifecycleState !== 'stopped') {
      delete tab.lifecycleState;
    }
    if (tab.recoverable !== undefined && typeof tab.recoverable !== 'boolean') {
      delete tab.recoverable;
    }
    if (tab.lifecycleReason !== undefined && !this.isWorkspaceLifecycleReason(tab.lifecycleReason)) {
      delete tab.lifecycleReason;
    }
    if (tab.cleanupStatus !== undefined && !this.isWorkspaceCleanupStatus(tab.cleanupStatus)) {
      delete tab.cleanupStatus;
    }
    if (tab.lastExitCode !== undefined && tab.lastExitCode !== null && !Number.isFinite(tab.lastExitCode)) {
      delete tab.lastExitCode;
    }
    if (tab.lifecycleUpdatedAt !== undefined && typeof tab.lifecycleUpdatedAt !== 'string') {
      delete tab.lifecycleUpdatedAt;
    }
    if (tab.generation !== undefined && (!Number.isInteger(tab.generation) || tab.generation < 1)) {
      delete tab.generation;
    }
    if (tab.generationReason !== undefined && tab.generationReason !== 'tab-restart' && tab.generationReason !== 'orphan-recovery') {
      delete tab.generationReason;
    }
  }

  private normalizeTabRecoveryMetadata(tab: WorkspaceTab): void {
    const hasAnyRecoveryMetadata = this.hasRecoveryMetadata(tab);
    if (!hasAnyRecoveryMetadata) {
      return;
    }

    if (
      typeof tab.recoveryOptionId !== 'string'
      || tab.recoveryOptionId.trim() === ''
      || typeof tab.recoveryCommand !== 'string'
      || tab.recoveryCommand.trim() === ''
    ) {
      this.clearTabRecoveryMetadata(tab);
      return;
    }

    if (tab.recoveryArguments === undefined) {
      tab.recoveryArguments = [];
    } else if (!Array.isArray(tab.recoveryArguments) || tab.recoveryArguments.some(argument => typeof argument !== 'string')) {
      this.clearTabRecoveryMetadata(tab);
      return;
    }

    if (tab.recoveryIcon !== undefined && tab.recoveryIcon !== null) {
      const safeIcon = this.cloneRecoveryIcon(tab.recoveryIcon);
      if (safeIcon) {
        tab.recoveryIcon = safeIcon;
      } else {
        delete tab.recoveryIcon;
      }
    }

    if (tab.recoveryUpdatedAt !== undefined && typeof tab.recoveryUpdatedAt !== 'string') {
      delete tab.recoveryUpdatedAt;
    }
  }

  private isWorkspaceLifecycleReason(value: unknown): value is WorkspaceTabLifecycleReason {
    return value === 'tab-delete'
      || value === 'workspace-delete'
      || value === 'tab-restart'
      || value === 'direct-session-delete'
      || value === 'process-exit'
      || value === 'shutdown'
      || value === 'orphan-recovery';
  }

  private isWorkspaceCleanupStatus(value: unknown): value is WorkspaceTabCleanupStatus {
    return value === 'not-started'
      || value === 'observed'
      || value === 'completed'
      || value === 'degraded'
      || value === 'failed';
  }

  private async commitTerminalTitle(sessionId: string, title: string): Promise<void> {
    const tab = this.state.tabs.find(t => t.sessionId === sessionId);
    if (!tab || !this.isTabAutoNameEligible(tab)) {
      return;
    }

    if (tab.name === title && tab.nameSource === 'terminal-title' && tab.terminalTitle === title) {
      return;
    }

    tab.name = title;
    tab.terminalTitle = title;
    tab.nameSource = 'terminal-title';
    await this.save();
    this.emitTabUpdated({
      tab,
      changes: {
        name: tab.name,
        terminalTitle: tab.terminalTitle,
        nameSource: tab.nameSource,
      },
    });
  }

  private isTerminalTitleEligible(sessionId: string): boolean {
    const tab = this.state.tabs.find(t => t.sessionId === sessionId);
    return Boolean(tab && this.isTabAutoNameEligible(tab));
  }

  private isTabAutoNameEligible(tab: WorkspaceTab): boolean {
    const source = tab.nameSource ?? (isDefaultTerminalTabName(tab.name) ? 'default' : 'user');
    return source === 'default' || source === 'terminal-title';
  }

  private cancelPendingTerminalTitle(sessionId: string): void {
    const pending = this.pendingTerminalTitles.get(sessionId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingTerminalTitles.delete(sessionId);
  }

  private normalizeTabNameMetadata(tab: WorkspaceTab): void {
    if (tab.nameSource !== 'default' && tab.nameSource !== 'terminal-title' && tab.nameSource !== 'user') {
      tab.nameSource = isDefaultTerminalTabName(tab.name) ? 'default' : 'user';
    }

    if (tab.terminalTitle !== undefined) {
      const sanitizedTitle = sanitizeTerminalTitle(tab.terminalTitle);
      if (sanitizedTitle) {
        tab.terminalTitle = sanitizedTitle;
      } else {
        delete tab.terminalTitle;
      }
    }
  }

  private emitTabUpdated(event: TabUpdatedEvent): void {
    if (!this.tabUpdatedCallback) {
      return;
    }
    try {
      this.tabUpdatedCallback(event);
    } catch (error) {
      console.warn('[WorkspaceService] tab update callback failed:', error);
    }
  }

  private migrateGridLayouts(): void {
    let migrated = false;
    this.state.gridLayouts = this.state.gridLayouts.map((g: any) => {
      if ('mosaicTree' in g) return g; // already new format
      if ('tabOrder' in g && Array.isArray(g.tabOrder) && g.tabOrder.length > 0) {
        migrated = true;
        return { workspaceId: g.workspaceId, mosaicTree: null }; // will rebuild on client
      }
      return { workspaceId: g.workspaceId, mosaicTree: null };
    });
    if (migrated) {
      console.log('[WorkspaceService] Migrated legacy GridLayout to mosaicTree format');
      this.save(true);
    }
  }

  private createDefaultState(): WorkspaceState {
    const now = new Date().toISOString();
    return {
      workspaces: [{
        id: uuidv4(),
        name: 'Workspace-1',
        sortOrder: 0,
        viewMode: 'tab',
        activeTabId: null,
        colorCounter: 0,
        createdAt: now,
        updatedAt: now,
      }],
      tabs: [],
      gridLayouts: [],
    };
  }

  // ============================================================================
  // Persistence (Phase 7: debounce + atomic write + backup)
  // ============================================================================

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isImmediateFlush = false;

  async save(immediate = false): Promise<void> {
    if (immediate || this.isImmediateFlush) {
      this.isImmediateFlush = false;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushToDisk();
      return;
    }

    // Debounced save
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      try {
        await this.flushToDisk();
      } catch (error) {
        console.error('[WorkspaceService] Deferred flush failed:', error);
      }
    }, this.config.flushDebounceMs);
  }

  /** Mark next save as immediate (for create/delete operations) */
  markImmediateFlush(): void {
    this.isImmediateFlush = true;
  }

  /** Force flush for graceful shutdown */
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushToDisk();
  }

  private async flushToDisk(): Promise<void> {
    const file: WorkspaceFile = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      state: this.state,
    };

    const tmpPath = this.dataFilePath + '.tmp';
    const bakPath = this.dataFilePath + '.bak';

    try {
      // Step 1: Write to temp file
      await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });

      // Step 2: Backup existing file
      try {
        await fs.copyFile(this.dataFilePath, bakPath);
      } catch {
        // No existing file to backup — OK on first run
      }

      // Step 3: Atomic rename (same directory = same partition on Windows)
      await fs.rename(tmpPath, this.dataFilePath);
    } catch (err: any) {
      console.error('[WorkspaceService] Flush failed:', err.message);
      // Clean up tmp file if it exists
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  // ============================================================================
  // Server Restart Recovery (Phase 7: FR-7706)
  // ============================================================================

  async checkOrphanTabs(): Promise<string[]> {
    const orphanTabIds: string[] = [];
    const restoredSessions: Array<{ tab: WorkspaceTab; sessionId: string }> = [];
    for (const tab of this.state.tabs) {
      if (!this.sessionManager.hasSession(tab.sessionId)) {
        if (!this.isRecoverableOrphanTab(tab)) {
          continue;
        }

        // Recreate session with saved CWD (or undefined → home directory fallback)
        try {
          const previousSessionId = tab.sessionId;
          this.cancelPendingTerminalTitle(previousSessionId);
          const sessionDTO = this.sessionManager.createSession(tab.name, tab.shellType, tab.lastCwd);
          tab.sessionId = sessionDTO.id;
          this.bindCurrentSessionId(tab, sessionDTO.id, previousSessionId);
          this.markTabActive(tab, 'orphan-recovery');
          orphanTabIds.push(tab.id);
          restoredSessions.push({ tab, sessionId: sessionDTO.id });
          console.log(`[Workspace] Orphan tab "${tab.name}" recovered: ${previousSessionId} → ${sessionDTO.id} (cwd: ${tab.lastCwd || 'default'})`);
        } catch (err) {
          console.error(`[Workspace] Failed to recover orphan tab "${tab.name}":`, err);
        }
      }
    }
    if (orphanTabIds.length > 0) {
      await this.save(true); // immediate save with new sessionIds
      for (const restored of restoredSessions) {
        await this.scheduleRecoveryRestoreForTab(restored.tab, restored.sessionId);
      }
    }
    return orphanTabIds;
  }

  /**
   * Snapshot all active session CWDs to tab metadata.
   * Reads CWD temp files directly as a final authoritative source,
   * falling back to SessionManager in-memory value.
   */
  snapshotAllCwds(): void {
    for (const tab of this.state.tabs) {
      // Try reading CWD temp file directly (most up-to-date, survives watchFile stop)
      const cwdFilePath = this.sessionManager.getCwdFilePath(tab.sessionId);
      if (cwdFilePath) {
        try {
          const raw = readFileSync(cwdFilePath, 'utf8');
          const cleaned = raw.replace(/^\uFEFF/, '').trim();
          if (cleaned && cleaned.length <= 4096 && !/[\x00-\x1f]/.test(cleaned)) {
            tab.lastCwd = cleaned;
            continue;
          }
        } catch { /* file may not exist — fall through */ }
      }
      // Fallback to SessionManager in-memory value
      const cwd = this.sessionManager.getLastCwd(tab.sessionId);
      if (cwd) {
        tab.lastCwd = cwd;
      }
    }
  }
}
