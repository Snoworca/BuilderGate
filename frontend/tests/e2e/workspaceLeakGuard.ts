import { link } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// REL-BGSTAB-001: list differences and workspace names never grant ownership.
export interface RegistryOptions {
  registryPath: string;
  runId: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}
export interface WorkspaceCleanupResult {
  deleted: string[];
  absent: string[];
  failed: Array<{ workspaceId: string; reason: string }>;
}
interface OwnershipRecord { runId: string; ownerId: string; workspaceId: string }
const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (id: string): string => createHash('sha256').update(id).digest('hex');

function optionsFor(input?: RegistryOptions): RegistryOptions {
  const options = input === undefined ? {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '',
    baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222',
  } : input;
  if (!object(options) || !hasText(options.registryPath) || !hasText(options.runId)
    || !hasText(options.baseUrl) || !URL.canParse(options.baseUrl)
    || (options.fetch !== undefined && typeof options.fetch !== 'function')) throw Error('Invalid workspace ownership options');
  const url = new URL(options.baseUrl);
  if (url.origin !== 'https://localhost:2222' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw Error('Workspace ownership requires the approved localhost HTTPS origin');
  }
  return { ...options, registryPath: resolve(options.registryPath), baseUrl: url.origin };
}

let tlsUsers = 0;
let previousTls: string | undefined;
async function withTls<T>(run: () => Promise<T>): Promise<T> {
  if (tlsUsers === 0) {
    previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  tlsUsers += 1;
  try { return await run(); }
  finally {
    tlsUsers -= 1;
    if (tlsUsers === 0) {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    }
  }
}

async function ready(options: RegistryOptions): Promise<{ token: string; ids: Set<string> }> {
  const request = options.fetch ?? globalThis.fetch;
  const login = await request(`${options.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.BUILDERGATE_PASSWORD || '1234' }),
  });
  if (!login.ok) throw Error(`E2E authentication failed (${login.status})`);
  const auth: unknown = await login.json();
  if (!object(auth) || !hasText(auth.token)) throw Error('E2E authentication returned no token');
  const response = await request(`${options.baseUrl}/api/workspaces`, { headers: { Authorization: `Bearer ${auth.token}` } });
  if (!response.ok) throw Error(`E2E workspace list failed (${response.status})`);
  const body: unknown = await response.json();
  if (!object(body) || !Array.isArray(body.workspaces)) throw Error('Invalid E2E workspace list');
  const ids = new Set<string>();
  for (const row of body.workspaces) {
    if (!object(row) || !hasText(row.id) || ids.has(row.id)) throw Error('Invalid E2E workspace identity list');
    ids.add(row.id);
  }
  return { token: auth.token, ids };
}

async function validateRun(options: RegistryOptions): Promise<void> {
  const meta: unknown = JSON.parse(await readFile(join(options.registryPath, 'run.json'), 'utf8'));
  if (!object(meta) || meta.runId !== options.runId || meta.baseUrl !== options.baseUrl) throw Error('Workspace ownership run mismatch');
}

export async function validateWorkspaceOwner(input: RegistryOptions & { ownerId: string }): Promise<RegistryOptions> {
  const options = optionsFor(input);
  if (!input || !hasText(input.ownerId)) throw Error('Invalid workspace owner');
  await validateRun(options);
  return options;
}

async function readRecord(options: RegistryOptions, name: string): Promise<OwnershipRecord> {
  const row: unknown = JSON.parse(await readFile(join(options.registryPath, 'records', name), 'utf8'));
  if (!object(row) || row.runId !== options.runId || !hasText(row.ownerId) || !hasText(row.workspaceId)
    || name !== `${digest(row.workspaceId)}.json`
    || Object.keys(row).sort().join(',') !== 'ownerId,runId,workspaceId') throw Error('Corrupt workspace ownership record');
  return { runId: options.runId, ownerId: row.ownerId, workspaceId: row.workspaceId };
}

export async function recordWorkspaceBaseline(input?: RegistryOptions): Promise<void> {
  if (input === undefined) {
    delete process.env.BUILDERGATE_E2E_RUN_DIR;
    delete process.env.BUILDERGATE_E2E_RUN_ID;
  }
  const runId = randomUUID();
  const options = optionsFor(input === undefined ? {
    registryPath: join(resolve(process.env.BUILDERGATE_E2E_OWNERSHIP_ROOT ?? 'test-results/.workspace-ownership'), runId),
    runId, baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222',
  } : input);
  await withTls(() => ready(options));
  await mkdir(dirname(options.registryPath), { recursive: true });
  await mkdir(options.registryPath); // Existing runs are never adopted or overwritten.
  await mkdir(join(options.registryPath, 'records'));
  await writeFile(join(options.registryPath, 'run.json'), JSON.stringify({ runId: options.runId, baseUrl: options.baseUrl }), { encoding: 'utf8', flag: 'wx' });
  if (input === undefined) {
    process.env.BUILDERGATE_E2E_RUN_DIR = options.registryPath;
    process.env.BUILDERGATE_E2E_RUN_ID = options.runId;
  }
}

export async function registerWorkspaceCreation(input: RegistryOptions & {
  ownerId: string;
  proof: { url: string; method: string; status: number; body: unknown };
}): Promise<{ workspaceId: string; registered: boolean }> {
  const options = await validateWorkspaceOwner(input);
  const proof = input.proof;
  if (!object(proof) || typeof proof.url !== 'string' || !URL.canParse(proof.url)
    || proof.method !== 'POST' || proof.status !== 201 || !object(proof.body) || !hasText(proof.body.id)
    || proof.body.id === '.' || proof.body.id === '..') throw Error('Invalid workspace creation response proof');
  const url = new URL(proof.url);
  if (url.origin !== options.baseUrl || url.pathname !== '/api/workspaces') throw Error('Foreign workspace creation response');
  const workspaceId = proof.body.id;
  const row = { runId: options.runId, ownerId: input.ownerId, workspaceId };
  const name = `${digest(workspaceId)}.json`;
  const directory = join(options.registryPath, 'records');
  const pending = join(directory, `.pending-${randomUUID()}`);
  await writeFile(pending, JSON.stringify(row), { encoding: 'utf8', flag: 'wx' });
  // A complete file is published atomically without replacing another owner.
  const error = await new Promise<NodeJS.ErrnoException | null>(done => link(pending, join(directory, name), error => done(error)));
  if (error && error.code !== 'EEXIST') throw error; // Retain the pending evidence.
  await unlink(pending);
  if (error) {
    const existing = await readRecord(options, name);
    if (existing.ownerId !== input.ownerId) throw Error('Workspace ownership conflict');
    return { workspaceId, registered: false };
  }
  return { workspaceId, registered: true };
}

async function cleanupRegistry(input: RegistryOptions & { ownerId?: string }, workspaceId?: string): Promise<WorkspaceCleanupResult> {
  const options = optionsFor(input);
  if (input.ownerId !== undefined && !hasText(input.ownerId)) throw Error('Invalid workspace owner');
  await validateRun(options);
  const records: OwnershipRecord[] = [];
  for (const entry of await readdir(join(options.registryPath, 'records'), { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) throw Error('Incomplete or corrupt workspace ownership registry');
    records.push(await readRecord(options, entry.name));
  }
  if (workspaceId !== undefined && !records.some(row => row.workspaceId === workspaceId && row.ownerId === input.ownerId)) {
    throw Error('Workspace is not owned by this context');
  }
  return withTls(async () => {
    const { token, ids } = await ready(options);
    const result: WorkspaceCleanupResult = { deleted: [], absent: [], failed: [] };
    for (const row of records) {
      if (input.ownerId !== undefined && row.ownerId !== input.ownerId) continue;
      if (workspaceId !== undefined && row.workspaceId !== workspaceId) continue;
      try {
        if (!ids.has(row.workspaceId)) result.absent.push(row.workspaceId);
        else {
          const response = await (options.fetch ?? globalThis.fetch)(`${options.baseUrl}/api/workspaces/${encodeURIComponent(row.workspaceId)}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          });
          if (response.status === 404) result.absent.push(row.workspaceId);
          else if (response.ok) result.deleted.push(row.workspaceId);
          else { result.failed.push({ workspaceId: row.workspaceId, reason: `DELETE returned ${response.status}` }); continue; }
        }
        await unlink(join(options.registryPath, 'records', `${digest(row.workspaceId)}.json`));
      } catch (error) {
        result.failed.push({ workspaceId: row.workspaceId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
}

export function cleanupOwnedWorkspaces(input: RegistryOptions & { ownerId?: string }): Promise<WorkspaceCleanupResult> {
  return cleanupRegistry(input);
}

export async function deleteOwnedWorkspace(input: RegistryOptions & { ownerId: string; workspaceId: string }): Promise<WorkspaceCleanupResult> {
  if (!input || !hasText(input.ownerId) || !hasText(input.workspaceId)) throw Error('Invalid owned workspace target');
  return cleanupRegistry(input, input.workspaceId);
}

export async function removeWorkspacesCreatedDuringRun(input?: RegistryOptions): Promise<void> {
  const result = await cleanupOwnedWorkspaces(optionsFor(input));
  console.log(`[e2e] workspaces: deleted=${result.deleted.length}, absent=${result.absent.length}, failed=${result.failed.length}`);
  if (result.failed.length) throw Error(`E2E workspace cleanup failed: ${JSON.stringify(result.failed)}`);
  if (input === undefined) {
    delete process.env.BUILDERGATE_E2E_RUN_DIR;
    delete process.env.BUILDERGATE_E2E_RUN_ID;
  }
}

// Playwright's FullConfig argument is not a RegistryOptions override.
export default async function setup(): Promise<void> { await recordWorkspaceBaseline(); }
