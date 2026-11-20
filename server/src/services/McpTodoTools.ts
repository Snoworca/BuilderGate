// FR-TODO-005: the to-do list over MCP. The tools go through TodoService, so an entry made here
// passes the same checks as one made in the panel.
import { TodoNotFoundError, TodoValidationError, type TodoAuthor, type TodoItem, type TodoService } from './todo/TodoService.js';

type Rec = Record<string, unknown>;

export type McpTodoControl = Pick<TodoService, 'list' | 'add' | 'update' | 'remove'>;

export const MCP_TODO_TOOL_NAMES = [
  'buildergate.todo.list',
  'buildergate.todo.add',
  'buildergate.todo.update',
  'buildergate.todo.delete',
] as const;

export type McpTodoToolName = typeof MCP_TODO_TOOL_NAMES[number];

const id = { type: 'integer', minimum: 1, description: 'The entry\'s absolute id (#n in the panel).' };

export const MCP_TODO_TOOL_SCHEMAS: Record<McpTodoToolName, Rec> = {
  'buildergate.todo.list': {
    type: 'object',
    properties: { includeDone: { type: 'boolean', description: 'Include completed entries (default true).' } },
    additionalProperties: false,
  },
  'buildergate.todo.add': {
    type: 'object',
    properties: {
      parentId: { ...id, description: 'Parent entry id. Omit for a new category. Entries nest at most three levels (category, item, sub-item).' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      detail: { type: 'string', maxLength: 20000, description: 'Longer description shown at the bottom of the panel.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  'buildergate.todo.update': {
    type: 'object',
    properties: {
      id,
      title: { type: 'string', minLength: 1, maxLength: 200 },
      detail: { type: 'string', maxLength: 20000 },
      done: { type: 'boolean' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  'buildergate.todo.delete': {
    type: 'object',
    properties: { id, confirm: { type: 'boolean', description: 'Must be true. Entries under it are deleted too.' } },
    required: ['id', 'confirm'],
    additionalProperties: false,
  },
};

export const MCP_TODO_TOOL_DESCRIPTIONS: Record<McpTodoToolName, string> = {
  'buildergate.todo.list': 'Return the server\'s to-do list (shown in the BuilderGate to-do panel) as a tree of categories, items and sub-items with their absolute ids.',
  'buildergate.todo.add': 'Add a to-do entry: a category without parentId, or an item/sub-item under parentId. Returns the new entry with its id.',
  'buildergate.todo.update': 'Change a to-do entry\'s title, detail or done state by id. Only the fields given change.',
  'buildergate.todo.delete': 'Delete a to-do entry and everything under it. Requires confirm: true.',
};

const REQUIRED_SCOPE: Record<McpTodoToolName, string> = {
  'buildergate.todo.list': 'mcp:todos.read',
  'buildergate.todo.add': 'mcp:todos.write',
  'buildergate.todo.update': 'mcp:todos.write',
  'buildergate.todo.delete': 'mcp:todos.write',
};

export function isMcpTodoTool(name: string): name is McpTodoToolName {
  return (MCP_TODO_TOOL_NAMES as readonly string[]).includes(name);
}

/** FR-TODO-001 AC-7: `author` is the calling session, resolved by the caller; never taken from the arguments. */
export async function callMcpTodoTool(control: McpTodoControl | undefined, name: McpTodoToolName, actor: Rec, args: Rec, author: TodoAuthor): Promise<Rec> {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  if (!scopes.includes(REQUIRED_SCOPE[name])) return { ok: false, code: 'INVALID_SCOPE' };
  if (!control) return { ok: false, code: 'MCP_TODO_CONTROL_UNAVAILABLE' };
  try {
    return await dispatch(control, name, args, author);
  } catch (error) {
    if (error instanceof TodoValidationError) return { ok: false, code: 'VALIDATION_ERROR', message: error.message, fieldErrors: { reason: error.reason } };
    if (error instanceof TodoNotFoundError) return { ok: false, code: 'TARGET_NOT_FOUND', message: error.message };
    return { ok: false, code: 'MCP_CONTROL_ERROR', message: error instanceof Error ? error.message : String(error) };
  }
}

async function dispatch(control: McpTodoControl, name: McpTodoToolName, args: Rec, author: TodoAuthor): Promise<Rec> {
  switch (name) {
    case 'buildergate.todo.list':
      return { ok: true, todos: todoTree(control.list(), args.includeDone !== false) };
    case 'buildergate.todo.add': {
      const parentId = args.parentId === undefined || args.parentId === null ? null : Number(args.parentId);
      return { ok: true, todo: await control.add({ parentId, title: args.title as string, detail: (args.detail as string | undefined) ?? '', author }) };
    }
    case 'buildergate.todo.update':
      return {
        ok: true,
        todo: await control.update(Number(args.id), {
          ...(args.title !== undefined ? { title: args.title as string } : {}),
          ...(args.detail !== undefined ? { detail: args.detail as string } : {}),
          ...(args.done !== undefined ? { done: args.done as boolean } : {}),
        }),
      };
    case 'buildergate.todo.delete':
      if (args.confirm !== true) return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { confirm: 'must be true' } };
      return { ok: true, removed: await control.remove(Number(args.id)) };
  }
}

type TodoNode = TodoItem & { children: TodoNode[] };

function todoTree(items: TodoItem[], includeDone: boolean): TodoNode[] {
  const shown = includeDone ? items : items.filter((item) => !item.done);
  const childrenOf = (parentId: number | null): TodoNode[] => shown
    .filter((item) => item.parentId === parentId)
    .map((item) => ({ ...item, children: childrenOf(item.id) }));
  return childrenOf(null);
}
