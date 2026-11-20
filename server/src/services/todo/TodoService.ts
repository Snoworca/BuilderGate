// FR-TODO-001: the server's one to-do list. Ids are absolute and never reused; entries form at most
// three levels (category, item, sub-item). The panel, REST and MCP all go through here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';

export interface TodoItem {
  id: number;
  /** null for a category. */
  parentId: number | null;
  title: string;
  detail: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TodoAddInput {
  parentId?: number | null;
  title: string;
  detail?: string;
}

export interface TodoUpdateInput {
  title?: string;
  detail?: string;
  done?: boolean;
}

export type TodoValidationReason = 'title' | 'detail' | 'depth' | 'done';

export class TodoValidationError extends Error {
  constructor(readonly reason: TodoValidationReason) {
    super(`invalid to-do ${reason}`);
    this.name = 'TodoValidationError';
  }
}

export class TodoNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`to-do not found: ${id}`);
    this.name = 'TodoNotFoundError';
  }
}

/** AC-3: category, item, sub-item. */
export const TODO_MAX_DEPTH = 3;
export const TODO_TITLE_MAX = 200;
export const TODO_DETAIL_MAX = 20_000;

interface TodoFile {
  version: 1;
  nextId: number;
  items: TodoItem[];
}

export interface TodoServiceOptions {
  dataPath?: string;
  /** AC-5: called after every change, to tell the browsers. */
  onChange?: () => void;
  now?: () => Date;
}

export class TodoService {
  private readonly dataFilePath: string;
  private readonly onChange: () => void;
  private readonly now: () => Date;
  private file: TodoFile = { version: 1, nextId: 1, items: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TodoServiceOptions = {}) {
    this.dataFilePath = path.resolve(options.dataPath ?? './data/todos.json');
    this.onChange = options.onChange ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    this.file = await this.load();
  }

  list(): TodoItem[] {
    return this.file.items.map((item) => ({ ...item }));
  }

  async add(input: TodoAddInput): Promise<TodoItem> {
    const parentId = input.parentId ?? null;
    if (parentId !== null && this.depthOf(this.find(parentId)) >= TODO_MAX_DEPTH) throw new TodoValidationError('depth');
    const at = this.now().toISOString();
    const item: TodoItem = {
      id: this.file.nextId,
      parentId,
      title: validTitle(input.title),
      detail: validDetail(input.detail ?? ''),
      done: false,
      createdAt: at,
      updatedAt: at,
    };
    this.file = { ...this.file, nextId: item.id + 1, items: [...this.file.items, item] };
    await this.commit();
    return { ...item };
  }

  async update(id: number, input: TodoUpdateInput): Promise<TodoItem> {
    const current = this.find(id);
    if (input.done !== undefined && typeof input.done !== 'boolean') throw new TodoValidationError('done');
    const next: TodoItem = {
      ...current,
      ...(input.title !== undefined ? { title: validTitle(input.title) } : {}),
      ...(input.detail !== undefined ? { detail: validDetail(input.detail) } : {}),
      ...(input.done !== undefined ? { done: input.done } : {}),
      updatedAt: this.now().toISOString(),
    };
    this.file = { ...this.file, items: this.file.items.map((item) => (item.id === id ? next : item)) };
    await this.commit();
    return { ...next };
  }

  /** AC-4: removes the entry and everything under it; answers the removed ids. */
  async remove(id: number): Promise<number[]> {
    this.find(id);
    const removed = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const item of this.file.items) {
        if (item.parentId !== null && removed.has(item.parentId) && !removed.has(item.id)) {
          removed.add(item.id);
          grew = true;
        }
      }
    }
    this.file = { ...this.file, items: this.file.items.filter((item) => !removed.has(item.id)) };
    await this.commit();
    return [...removed];
  }

  private find(id: number): TodoItem {
    const item = this.file.items.find((entry) => entry.id === id);
    if (!item) throw new TodoNotFoundError(id);
    return item;
  }

  /** 1 for a category. */
  private depthOf(item: TodoItem): number {
    let depth = 1;
    for (let parent = item.parentId; parent !== null; depth += 1) {
      parent = this.file.items.find((entry) => entry.id === parent)?.parentId ?? null;
    }
    return depth;
  }

  private async commit(): Promise<void> {
    await this.persist();
    this.onChange();
  }

  private async load(): Promise<TodoFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.dataFilePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nextId: 1, items: [] };
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<TodoFile>;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const highest = items.reduce((max, item) => Math.max(max, item.id), 0);
    return { version: 1, nextId: Math.max(Number(parsed.nextId) || 1, highest + 1), items };
  }

  private persist(): Promise<void> {
    const contents = JSON.stringify(this.file, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => publishStoreAtomically(this.dataFilePath, contents, { ensureDirectory: true }));
    return this.writeChain;
  }
}

function validTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > TODO_TITLE_MAX) throw new TodoValidationError('title');
  return title;
}

function validDetail(value: unknown): string {
  if (typeof value !== 'string' || value.length > TODO_DETAIL_MAX) throw new TodoValidationError('detail');
  return value;
}
