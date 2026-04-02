import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import type { Workspace, WorkspaceTab, GridLayout, WorkspaceState, WorkspaceFile } from '../types/workspace.types.js';
import type { ShellType } from '../types/index.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { config } from '../utils/config.js';
import type { SessionManager } from './SessionManager.js';

interface WorkspaceConfig {
  dataPath: string;
  maxWorkspaces: number;
  maxTabsPerWorkspace: number;
  maxTotalSessions: number;
  flushDebounceMs: number;
}

export class WorkspaceService {
  private state: WorkspaceState = { workspaces: [], tabs: [], gridLayouts: [] };
  private config: WorkspaceConfig;
  private dataFilePath: string;
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    const wsConfig = (config as any).workspace;
    this.config = {
      dataPath: wsConfig?.dataPath ?? './data/workspaces.json',
      maxWorkspaces: wsConfig?.maxWorkspaces ?? 10,
      maxTabsPerWorkspace: wsConfig?.maxTabsPerWorkspace ?? 8,
      maxTotalSessions: wsConfig?.maxTotalSessions ?? 32,
      flushDebounceMs: wsConfig?.flushDebounceMs ?? 5000,
    };
    this.dataFilePath = path.resolve(this.config.dataPath);
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

    // Migrate legacy GridLayout (columns/rows/cellSizes → mosaicTree)
    this.migrateGridLayouts();

    // Ensure at least one workspace exists
    if (this.state.workspaces.length === 0) {
      this.state = this.createDefaultState();
      await this.save();
    }
  }

  // ============================================================================
  // Getters
  // ============================================================================

  getState(): WorkspaceState {
    return this.state;
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
    this.sessionManager.deleteMultipleSessions(sessionIds);

    // Remove tabs, grid layouts, and workspace
    this.state.tabs = this.state.tabs.filter(t => t.workspaceId !== id);
    this.state.gridLayouts = this.state.gridLayouts.filter(g => g.workspaceId !== id);
    this.state.workspaces = this.state.workspaces.filter(w => w.id !== id);

    await this.save(true);
  }

  async reorderWorkspaces(workspaceIds: string[]): Promise<void> {
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
      name: name || `Terminal-${wsTabs.length + 1}`,
      colorIndex,
      sortOrder: wsTabs.length,
      shellType,
      createdAt: new Date().toISOString(),
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
      tab.name = trimmedName;
    }

    await this.save();
    return tab;
  }

  async deleteTab(workspaceId: string, tabId: string): Promise<void> {
    const tab = this.getTab(tabId);
    if (tab.workspaceId !== workspaceId) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }

    // Terminate PTY session
    this.sessionManager.deleteSession(tab.sessionId);

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
    for (let i = 0; i < tabIds.length; i++) {
      const tab = this.state.tabs.find(t => t.id === tabIds[i] && t.workspaceId === workspaceId);
      if (tab) tab.sortOrder = i;
    }
    await this.save();
  }

  async restartTab(workspaceId: string, tabId: string): Promise<WorkspaceTab> {
    const tab = this.getTab(tabId);
    if (tab.workspaceId !== workspaceId) {
      throw new AppError(ErrorCode.TAB_NOT_FOUND);
    }

    // Create new PTY session with same shell type
    const sessionDTO = this.sessionManager.createSession(tab.name, tab.shellType);
    tab.sessionId = sessionDTO.id;

    await this.save();
    return tab;
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
      await this.flushToDisk();
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
    }
  }

  // ============================================================================
  // Server Restart Recovery (Phase 7: FR-7706)
  // ============================================================================

  async checkOrphanTabs(): Promise<string[]> {
    const orphanTabIds: string[] = [];
    for (const tab of this.state.tabs) {
      if (!this.sessionManager.hasSession(tab.sessionId)) {
        orphanTabIds.push(tab.id);
      }
    }
    return orphanTabIds;
  }
}
