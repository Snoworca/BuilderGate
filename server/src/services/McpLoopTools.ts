// FR-LOOP-007: Tools › Loop over MCP. The tools go through LoopService, so a loop made here passes
// the same checks as one made in the loop window or over REST.
import { LoopNotFoundError, LoopValidationError, type LoopDefinition, type LoopRun, type LoopService } from './loop/LoopService.js';

type Rec = Record<string, unknown>;

export type McpLoopControl = Pick<LoopService, 'list' | 'get' | 'history' | 'create' | 'update' | 'remove' | 'startNow'>;

export const MCP_LOOP_TOOL_NAMES = [
  'buildergate.loop.list',
  'buildergate.loop.history',
  'buildergate.loop.create',
  'buildergate.loop.update',
  'buildergate.loop.delete',
  'buildergate.loop.run',
] as const;

export type McpLoopToolName = typeof MCP_LOOP_TOOL_NAMES[number];

const HISTORY_DEFAULT = 10;
const HISTORY_MAX = 50;

const loopRef = {
  loopId: { type: 'string', description: 'Loop id. Use this or loopName.' },
  loopName: { type: 'string', description: 'Loop name. Use this or loopId.' },
};

const SHELLS = ['auto', 'powershell', 'wsl', 'bash', 'zsh', 'sh', 'cmd'];

const time = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'HH:MM, 24-hour, server local time.' };
const times = { type: 'array', items: time, minItems: 1 };

const schedule = {
  description: 'When it runs, in the server\'s local time.',
  oneOf: [
    {
      type: 'object',
      properties: { kind: { const: 'weekly' }, days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1, description: '0 = Sunday … 6 = Saturday.' }, times },
      required: ['kind', 'days', 'times'],
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'monthly' },
        dates: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 31 }, description: 'A date a month lacks is skipped.' },
        lastDay: { type: 'boolean', description: 'Also each month\'s last day.' },
        times,
      },
      required: ['kind', 'dates', 'times'],
    },
    {
      type: 'object',
      properties: { kind: { const: 'once' }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD.' }, times },
      required: ['kind', 'date', 'times'],
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'interval' },
        everyMinutes: { type: 'integer', minimum: 1 },
        startsAt: { type: 'string', description: 'YYYY-MM-DDTHH:MM; counts on from here across midnight.' },
      },
      required: ['kind', 'everyMinutes', 'startsAt'],
    },
  ],
};

const step = {
  oneOf: [
    { type: 'object', properties: { kind: { const: 'command' }, text: { type: 'string', description: 'One line typed into the shell, then Enter.' } }, required: ['kind', 'text'] },
    { type: 'object', properties: { kind: { const: 'prompt' }, text: { type: 'string', description: 'Text for the agent started above (may span lines), then Enter.' } }, required: ['kind', 'text'] },
    { type: 'object', properties: { kind: { const: 'delay' }, ms: { type: 'integer', minimum: 0, maximum: 3_600_000 } }, required: ['kind', 'ms'] },
    { type: 'object', properties: { kind: { const: 'end' } }, required: ['kind'], description: 'Closes the tab. Last step only.' },
  ],
};

const loopFields = {
  name: { type: 'string', description: 'Loop name (1-64 characters).' },
  enabled: { type: 'boolean', description: 'Whether the schedule runs it. Default true.' },
  schedule,
  shell: { type: 'string', enum: SHELLS, description: 'Shell for the new tab; auto is the server\'s default shell.' },
  cwd: { type: 'string', description: 'Folder the new tab opens in.' },
  keepTabs: { type: 'integer', minimum: 1, maximum: 16, description: 'Tabs of runs without a session end kept open (default 1); the oldest beyond this close.' },
  steps: {
    type: 'array',
    minItems: 1,
    description: 'Sent top to bottom in a new tab of a @schedule-{n} workspace. Commands do not wait for the one before; use a delay. '
      + 'Example: [{"kind":"command","text":"codex"},{"kind":"delay","ms":2000},{"kind":"prompt","text":"..."}].',
    items: step,
  },
};

export const MCP_LOOP_TOOL_SCHEMAS: Record<McpLoopToolName, Rec> = {
  'buildergate.loop.list': { type: 'object', properties: {}, additionalProperties: false },
  'buildergate.loop.history': {
    type: 'object',
    properties: { ...loopRef, limit: { type: 'integer', minimum: 1, maximum: HISTORY_MAX, description: `Runs to return, newest first (default ${HISTORY_DEFAULT}).` } },
    additionalProperties: false,
  },
  'buildergate.loop.create': {
    type: 'object',
    properties: loopFields,
    required: ['name', 'schedule', 'shell', 'cwd', 'steps'],
    additionalProperties: false,
  },
  'buildergate.loop.update': {
    type: 'object',
    properties: { ...loopRef, ...loopFields },
    additionalProperties: false,
  },
  'buildergate.loop.delete': {
    type: 'object',
    properties: { ...loopRef, confirm: { type: 'boolean', description: 'Must be true.' } },
    required: ['confirm'],
    additionalProperties: false,
  },
  'buildergate.loop.run': { type: 'object', properties: { ...loopRef }, additionalProperties: false },
};

export const MCP_LOOP_TOOL_DESCRIPTIONS: Record<McpLoopToolName, string> = {
  'buildergate.loop.list': 'List BuilderGate loops (scheduled shell sessions) with their next run and last result.',
  'buildergate.loop.history': 'Return the recent runs of a loop given by loopId or loopName.',
  'buildergate.loop.create': 'Register a loop: on a schedule it opens a new tab with the given shell and folder and sends its steps in order.',
  'buildergate.loop.update': 'Change a loop given by loopId or loopName. Only the fields given change.',
  'buildergate.loop.delete': 'Delete a loop. Requires confirm: true. Tabs it opened stay open.',
  'buildergate.loop.run': 'Run a loop once now, whatever its schedule. Answers as soon as the run starts.',
};

const REQUIRED_SCOPE: Record<McpLoopToolName, string> = {
  'buildergate.loop.list': 'mcp:loops.read',
  'buildergate.loop.history': 'mcp:loops.read',
  'buildergate.loop.create': 'mcp:loops.write',
  'buildergate.loop.update': 'mcp:loops.write',
  'buildergate.loop.delete': 'mcp:loops.write',
  'buildergate.loop.run': 'mcp:loops.write',
};

export function isMcpLoopTool(name: string): name is McpLoopToolName {
  return (MCP_LOOP_TOOL_NAMES as readonly string[]).includes(name);
}

export async function callMcpLoopTool(control: McpLoopControl | undefined, name: McpLoopToolName, actor: Rec, args: Rec): Promise<Rec> {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  if (!scopes.includes(REQUIRED_SCOPE[name])) return { ok: false, code: 'INVALID_SCOPE' };
  if (!control) return { ok: false, code: 'MCP_LOOP_CONTROL_UNAVAILABLE' };
  try {
    return await dispatch(control, name, args);
  } catch (error) {
    if (error instanceof LoopValidationError) return { ok: false, code: 'VALIDATION_ERROR', message: error.message, fieldErrors: { reason: error.reason } };
    if (error instanceof LoopNotFoundError) return { ok: false, code: 'TARGET_NOT_FOUND', message: error.message };
    return { ok: false, code: 'MCP_CONTROL_ERROR', message: error instanceof Error ? error.message : String(error) };
  }
}

async function dispatch(control: McpLoopControl, name: McpLoopToolName, args: Rec): Promise<Rec> {
  if (name === 'buildergate.loop.list') return { ok: true, loops: control.list().map((loop) => loopView(control, loop)) };
  if (name === 'buildergate.loop.create') return { ok: true, loop: loopView(control, await control.create(definitionOf(args))) };

  const target = resolveLoop(control.list(), args);
  if (!target.ok) return target.error;
  const loop = target.loop;
  switch (name) {
    case 'buildergate.loop.history': {
      const limit = Number.isInteger(args.limit) ? Math.min(HISTORY_MAX, Math.max(1, args.limit as number)) : HISTORY_DEFAULT;
      return { ok: true, loopId: loop.id, runs: control.history(loop.id).slice(0, limit).map(runView) };
    }
    case 'buildergate.loop.update': {
      const { id: _id, nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...current } = loop;
      return { ok: true, loop: loopView(control, await control.update(loop.id, { ...current, ...definitionOf(args) })) };
    }
    case 'buildergate.loop.delete':
      if (args.confirm !== true) return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { confirm: 'must be true' } };
      await control.remove(loop.id);
      return { ok: true, deleted: { loopId: loop.id, name: loop.name } };
    case 'buildergate.loop.run':
      return { ok: true, loopId: loop.id, run: runView(control.startNow(loop.id)) };
  }
}

/** The definition fields the caller gave, and nothing else. */
function definitionOf(args: Rec): Rec {
  const fields: Rec = {};
  for (const key of Object.keys(loopFields)) {
    if (args[key] !== undefined) fields[key] = args[key];
  }
  return fields;
}

type Resolved = { ok: true; loop: LoopDefinition } | { ok: false; error: Rec };

function resolveLoop(loops: LoopDefinition[], args: Rec): Resolved {
  const id = typeof args.loopId === 'string' ? args.loopId.trim() : '';
  const name = typeof args.loopName === 'string' ? args.loopName.trim() : '';
  if (!id && !name) return { ok: false, error: { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { loopId: 'loopId or loopName is required' } } };
  const matches = loops.filter((loop) => (id ? loop.id === id : loop.name === name));
  if (id && name && matches.length === 1 && matches[0].name !== name) {
    return { ok: false, error: { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { loopName: 'does not match loopId' } } };
  }
  if (matches.length === 0) return { ok: false, error: { ok: false, code: 'TARGET_NOT_FOUND', fieldErrors: { [id ? 'loopId' : 'loopName']: `not found: ${id || name}` } } };
  if (matches.length > 1) {
    return { ok: false, error: { ok: false, code: 'AMBIGUOUS_TARGET', candidates: matches.map((loop) => ({ loopId: loop.id, name: loop.name })) } };
  }
  return { ok: true, loop: matches[0] };
}

function loopView(control: McpLoopControl, loop: LoopDefinition): Rec {
  const { id, ...rest } = loop;
  const last = control.history(id)[0];
  return { loopId: id, ...rest, lastRun: last ? runView(last) : null };
}

function runView(run: LoopRun): Rec {
  const { id, loopId: _loopId, ...rest } = run;
  return { runId: id, ...rest };
}
