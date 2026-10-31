// FR-USAGE-002 / FR-USAGE-003: Claude Code reports its limits only to the statusline command's
// stdin. The relay sits in front of the user's statusline: it records the limits with the account
// and runs the original statusline with the same input, so the statusline looks the same.
//
// The relay is a standalone script Claude Code runs; its source lives here, in one place, and is
// written into each Claude config folder when collection is turned on.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UsageReading, UsageSource, UsageWindowKind, UsageWindowReading } from './usageModel.js';

export const CLAUDE_RELAY_FILE = 'buildergate-usage-relay.mjs';
export const CLAUDE_USAGE_FILE = 'buildergate-usage.json';
/** Holds the statusLine the relay replaced, so it can run it and so turning off can restore it. */
export const CLAUDE_RELAY_STATE_FILE = 'buildergate-statusline.json';

/** FR-USAGE-002: the script Claude Code runs as its statusline while collection is on. */
export function claudeRelaySource(): string {
  return `#!/usr/bin/env node
// BuilderGate usage relay (FR-USAGE-002). Records Claude Code's rate limits and the account, then
// runs the statusline it replaced with the same input. Turn it off in BuilderGate to restore it.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The script's own folder is the Claude config folder it was installed into.
const dir = path.dirname(path.resolve(process.argv[1]));
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  try { record(JSON.parse(input.toString('utf8'))); } catch {}
  runOriginal(input);
});

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function account() {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'),
    path.join(dir, '.claude.json'),
    path.join(homedir(), '.claude.json'),
  ].filter(Boolean);
  const file = candidates.find((candidate) => existsSync(candidate));
  const oauth = file ? readJson(file)?.oauthAccount : null;
  if (!oauth || !oauth.accountUuid) return null;
  const key = createHash('sha256').update('claude\\u0000' + oauth.accountUuid + '\\u0000' + (oauth.organizationUuid || '')).digest('hex').slice(0, 16);
  // The whole address, so the account can be told at a glance (user decision 2026-10-31).
  const email = typeof oauth.emailAddress === 'string' && oauth.emailAddress.includes('@') ? oauth.emailAddress : null;
  return { key, email, plan: oauth.planDisplayName || oauth.organizationType || null };
}

function windowOf(value) {
  if (!value || typeof value.used_percentage !== 'number') return null;
  return { used_percentage: value.used_percentage, resets_at: value.resets_at ?? null };
}

function record(input) {
  const limits = input && input.rate_limits;
  const fiveHour = windowOf(limits && limits.five_hour);
  const sevenDay = windowOf(limits && limits.seven_day);
  if (!fiveHour && !sevenDay) return;
  const who = account();
  const key = who ? who.key : 'unknown';
  const file = path.join(dir, '${CLAUDE_USAGE_FILE}');
  const current = readJson(file);
  const data = current && current.version === 1 && current.accounts ? current : { version: 1, accounts: {} };
  data.accounts[key] = {
    email: who ? who.email : null,
    plan: who ? who.plan : null,
    observedAt: new Date().toISOString(),
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  // On Windows a rename fails while another Claude session is renaming onto the same file; try a
  // few times, and never leave the temp file behind (the next render records again anyway).
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 4) {
        try { rmSync(tmp, { force: true }); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

// Claude Code runs commands on Windows in Git Bash, so the original statusline does too. The bash
// first on PATH there is often WSL's (System32\\bash.exe), so Git Bash is found next to git.
function gitBash() {
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (entry && existsSync(path.join(entry, 'git.exe'))) candidates.push(path.join(entry, '..', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe', 'C:\\\\Program Files (x86)\\\\Git\\\\bin\\\\bash.exe');
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function runOriginal(input) {
  const state = readJson(path.join(dir, '${CLAUDE_RELAY_STATE_FILE}'));
  const command = state && state.original && typeof state.original.command === 'string' ? state.original.command : null;
  if (!command) process.exit(0);
  const bash = process.platform === 'win32' ? gitBash() : null;
  const options = { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true };
  const child = bash ? spawn(bash, ['-c', command], options) : spawn(command, { ...options, shell: true });
  child.on('error', () => process.exit(0));
  child.on('exit', (code) => process.exit(code ?? 0));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
}
`;
}

export interface ClaudeConfigRef {
  configDir: string;
  source: UsageSource;
}

/** FR-USAGE-001/004: the relay's records as readings. */
export async function readClaudeUsage(dirs: readonly ClaudeConfigRef[]): Promise<UsageReading[]> {
  const readings: UsageReading[] = [];
  for (const ref of dirs) {
    const data = await readJsonFile(path.join(ref.configDir, CLAUDE_USAGE_FILE));
    const accounts = asRecord(asRecord(data)?.accounts);
    if (!accounts) continue;
    for (const [key, value] of Object.entries(accounts)) {
      const entry = asRecord(value);
      const observedAt = Date.parse(String(entry?.observedAt ?? ''));
      if (!entry || !Number.isFinite(observedAt)) continue;
      const windows: Partial<Record<UsageWindowKind, UsageWindowReading>> = {};
      const five = toWindow(entry.five_hour);
      const week = toWindow(entry.seven_day);
      if (five) windows.fiveHour = five;
      if (week) windows.weekly = week;
      readings.push({
        agent: 'claude',
        accountKey: key === 'unknown' ? null : key,
        email: typeof entry.email === 'string' ? entry.email : null,
        plan: typeof entry.plan === 'string' ? entry.plan : null,
        source: ref.source,
        observedAt,
        windows,
      });
    }
  }
  return readings;
}

export interface InstallOptions {
  /** Where the settings, the relay and its records live, as this server reaches it. */
  configDir: string;
  /** The same folder as Claude Code sees it (a Linux path for WSL), used in the command. */
  commandPath: string;
  /** The node Claude Code should run the relay with. */
  nodeCommand: string;
}

const isRelayCommand = (command: unknown) => typeof command === 'string' && command.includes(CLAUDE_RELAY_FILE);

/** FR-USAGE-003 AC-1/AC-3. */
export async function installClaudeRelay(options: InstallOptions): Promise<void> {
  const settingsPath = path.join(options.configDir, 'settings.json');
  const settings = (await readJsonFile(settingsPath, { missing: {} })) as Record<string, unknown>;
  const current = asRecord(settings.statusLine);
  if (!isRelayCommand(current?.command)) {
    await writeJsonAtomic(path.join(options.configDir, CLAUDE_RELAY_STATE_FILE), { version: 1, original: current ?? null });
  }
  await fs.writeFile(path.join(options.configDir, CLAUDE_RELAY_FILE), claudeRelaySource(), { mode: 0o755 });
  const command = `${options.nodeCommand} "${options.commandPath.replace(/\/$/u, '')}/${CLAUDE_RELAY_FILE}"`;
  const base = isRelayCommand(current?.command) ? current : (current ?? {});
  settings.statusLine = { ...base, type: 'command', command };
  await writeJsonAtomic(settingsPath, settings);
}

/** FR-USAGE-003 AC-2. */
export async function uninstallClaudeRelay(configDir: string): Promise<void> {
  const settingsPath = path.join(configDir, 'settings.json');
  const statePath = path.join(configDir, CLAUDE_RELAY_STATE_FILE);
  const state = asRecord(await readJsonFile(statePath));
  const settings = (await readJsonFile(settingsPath, { missing: {} })) as Record<string, unknown>;
  if (isRelayCommand(asRecord(settings.statusLine)?.command)) {
    const original = asRecord(state?.original);
    if (original) settings.statusLine = original;
    else delete settings.statusLine;
    await writeJsonAtomic(settingsPath, settings);
  }
  await fs.rm(path.join(configDir, CLAUDE_RELAY_FILE), { force: true });
  await fs.rm(statePath, { force: true });
  // With collection off, the last record would only show as a stale bar.
  await fs.rm(path.join(configDir, CLAUDE_USAGE_FILE), { force: true });
}

/** FR-USAGE-003 AC-4: installed, or turned on but replaced since. */
export async function relayStatus(configDir: string): Promise<{ installed: boolean; drifted: boolean }> {
  const settings = asRecord(await readJsonFile(path.join(configDir, 'settings.json')));
  const installed = isRelayCommand(asRecord(settings?.statusLine)?.command);
  const stateExists = await fs.stat(path.join(configDir, CLAUDE_RELAY_STATE_FILE)).then(() => true, () => false);
  return { installed, drifted: !installed && stateExists };
}

function toWindow(value: unknown): UsageWindowReading | null {
  const window = asRecord(value);
  if (!window || typeof window.used_percentage !== 'number') return null;
  const raw = window.resets_at;
  const resetsAt = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : typeof raw === 'string' ? Date.parse(raw) : NaN;
  return { usedPercent: window.used_percentage, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

async function readJsonFile(file: string, options: { missing?: unknown } = {}): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return options.missing ?? null;
    throw error;
  }
  // A settings file that will not parse is the user's; it is never overwritten.
  return JSON.parse(text);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
