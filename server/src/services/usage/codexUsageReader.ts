// FR-USAGE-001: Codex limits per account, from the session rollouts Codex already writes. The
// account is the rollout's `session_meta.creator_account_id`; auth.json is never read.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeReadings, type UsageReading, type UsageSource, type UsageWindowKind, type UsageWindowReading } from './usageModel.js';

export interface CodexHomeRef {
  codexHome: string;
  source: UsageSource;
}

/** Rollouts older than this are past any weekly reset and not worth reading. */
const LOOKBACK_MS = 8 * 24 * 3_600_000;
const CHUNK_BYTES = 64 * 1024;
/** Day folders older than the look-back by this much are not walked (FR-USAGE-001 AC-3). */
const FOLDER_SKIP_MARGIN_MS = 30 * 24 * 3_600_000;
/** The first line carries the instructions and can be large; a line longer than this is skipped. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const WINDOW_BY_MINUTES: Record<number, UsageWindowKind> = { 300: 'fiveHour', 10080: 'weekly' };

export function hashAccount(agent: string, id: string): string {
  return createHash('sha256').update(`${agent}\u0000${id}`).digest('hex').slice(0, 16);
}

/** FR-USAGE-001 AC-2: a token_count event's limits, keyed by window length. */
export function parseCodexRateLimits(event: unknown): { observedAt: number; plan: string | null; windows: Partial<Record<UsageWindowKind, UsageWindowReading>> } | null {
  const record = asRecord(event);
  const payload = asRecord(record?.payload);
  const limits = asRecord(payload?.rate_limits);
  if (!limits) return null;
  // Only the main Codex limit; other buckets (e.g. `premium`) are separate quotas. Older CLIs omit the id.
  if (typeof limits.limit_id === 'string' && limits.limit_id !== 'codex') return null;
  const observedAt = Date.parse(String(record?.timestamp ?? ''));
  if (!Number.isFinite(observedAt)) return null;
  const windows: Partial<Record<UsageWindowKind, UsageWindowReading>> = {};
  for (const slot of [limits.primary, limits.secondary]) {
    const window = asRecord(slot);
    const kind = window ? WINDOW_BY_MINUTES[Number(window.window_minutes)] : undefined;
    if (!window || !kind || typeof window.used_percent !== 'number') continue;
    const resetsAt = typeof window.resets_at === 'number'
      ? window.resets_at * 1000
      : typeof window.resets_in_seconds === 'number' ? observedAt + window.resets_in_seconds * 1000 : null;
    windows[kind] = { usedPercent: window.used_percent, resetsAt };
  }
  return { observedAt, plan: typeof limits.plan_type === 'string' ? limits.plan_type : null, windows };
}

interface ParsedRollout {
  accountKey: string | null;
  limits: ReturnType<typeof parseCodexRateLimits>;
}

export function createCodexUsageReader(options: { now?: () => number; onFileRead?: (file: string) => void } = {}) {
  const now = options.now ?? (() => Date.now());
  /** path → parse of the file at that mtime and size. */
  const cache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedRollout }>();

  async function parseRollout(file: string, size: number): Promise<ParsedRollout> {
    options.onFileRead?.(file);
    const handle = await fs.open(file, 'r');
    try {
      const head = await readFirstLine(handle, size);
      const meta = head ? asRecord(asRecord(safeJson(head))?.payload) : null;
      const accountId = typeof meta?.creator_account_id === 'string' && meta.creator_account_id ? meta.creator_account_id : null;
      return { accountKey: accountId ? hashAccount('codex', accountId) : null, limits: await readLastLimits(handle, size) };
    } finally {
      await handle.close();
    }
  }

  async function read(homes: readonly CodexHomeRef[]): Promise<UsageReading[]> {
    const readings: UsageReading[] = [];
    const seen = new Set<string>();
    for (const home of homes) {
      const files = await listRecentRollouts(path.join(home.codexHome, 'sessions'), now() - LOOKBACK_MS);
      for (const file of files) {
        seen.add(file.path);
        let entry = cache.get(file.path);
        if (!entry || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) {
          const parsed = await parseRollout(file.path, file.size).catch(() => ({ accountKey: null, limits: null }));
          entry = { mtimeMs: file.mtimeMs, size: file.size, parsed };
          cache.set(file.path, entry);
        }
        const { accountKey, limits } = entry.parsed;
        if (!limits) continue;
        readings.push({ agent: 'codex', accountKey, email: null, plan: limits.plan, source: home.source, observedAt: limits.observedAt, windows: limits.windows });
      }
    }
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    // FR-USAGE-001 AC-3: the newest record per account (per source when the account is unknown).
    return mergeReadings(readings);
  }

  return { read };
}

async function listRecentRollouts(sessionsDir: string, since: number): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  // sessions/YYYY/MM/DD: a folder whose whole period ended before `since` is not walked.
  const periodEnd = (parts: number[]): number => {
    const [year, month, day] = parts;
    if (month === undefined) return Date.UTC(year + 1, 0, 1);
    if (day === undefined) return Date.UTC(year, month, 1);
    return Date.UTC(year, month - 1, day + 1);
  };
  const walk = async (dir: string, depth: number, period: number[] = []): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const value = Number(entry.name);
        const next = Number.isInteger(value) && /^\d+$/u.test(entry.name) ? [...period, value] : null;
        // A resumed or long session keeps writing into the folder of the day it began, so folders
        // are skipped by name only when far older than any live session; files go by mtime.
        if (next && next.length === depth + 1 && periodEnd(next) + FOLDER_SKIP_MARGIN_MS < since) continue;
        await walk(full, depth + 1, next ?? period);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.mtimeMs >= since) out.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  await walk(sessionsDir, 0);
  return out;
}

async function readFirstLine(handle: import('node:fs/promises').FileHandle, size: number): Promise<string | null> {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < size && offset < MAX_LINE_BYTES) {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      parts.push(chunk.subarray(0, newline));
      return Buffer.concat(parts).toString('utf8');
    }
    parts.push(chunk);
    offset += bytesRead;
  }
  return offset >= size ? Buffer.concat(parts).toString('utf8') : null;
}

/** The last token_count limits, read backwards from the end of the file. */
async function readLastLimits(handle: import('node:fs/promises').FileHandle, size: number): Promise<ReturnType<typeof parseCodexRateLimits>> {
  let end = size;
  let carry = Buffer.alloc(0);
  while (end > 0 && size - end < MAX_LINE_BYTES) {
    const start = Math.max(0, end - CHUNK_BYTES);
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    const block = Buffer.concat([buffer, carry]);
    const lines = block.toString('utf8').split('\n');
    // The first piece may be a partial line; keep it for the next, earlier block.
    carry = start > 0 ? Buffer.from(lines.shift() ?? '', 'utf8') : Buffer.alloc(0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const parsed = parseCodexRateLimits(safeJson(lines[i]));
      if (parsed) return parsed;
    }
    end = start;
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
