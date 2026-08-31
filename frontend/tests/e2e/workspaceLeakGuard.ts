import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Keeps an e2e run from exhausting the workspace quota.
 *
 * `maxLiveWorkspaces` defaults to 10 and a dozen specs create workspaces under
 * as many naming schemes without removing them. Measured 2026-08-30 every slot
 * held a leftover, so `POST /api/workspaces` answered 409 and then 500 and
 * unrelated specs failed in a way that reads as a product defect.
 *
 * The run is bracketed rather than name-matched: what existed before it is
 * recorded, and only what appeared afterwards is removed. A workspace someone
 * was actually using is therefore never a candidate, whatever it is called.
 */

export interface WorkspaceRef {
  id: string;
  name: string;
}

/** Set difference by id. Names repeat across runs; ids do not. */
export function workspacesCreatedDuringRun(
  before: readonly WorkspaceRef[],
  after: readonly WorkspaceRef[],
): WorkspaceRef[] {
  const known = new Set(before.map(workspace => workspace.id));
  return after.filter(workspace => !known.has(workspace.id));
}

const BASELINE_PATH = resolve(
  process.env.BUILDERGATE_E2E_BASELINE ?? 'test-results/.workspace-baseline.json',
);

function baseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';
}

/** The dev server presents a self-signed certificate. */
function relaxTls(): () => void {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return () => {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  };
}

async function issueToken(): Promise<string | null> {
  const password = process.env.BUILDERGATE_PASSWORD || '1234';
  const response = await fetch(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) return null;
  const body = await response.json() as { token?: string };
  return typeof body.token === 'string' ? body.token : null;
}

async function listWorkspaces(token: string): Promise<WorkspaceRef[]> {
  const response = await fetch(`${baseUrl()}/api/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return [];
  const body = await response.json() as { workspaces?: WorkspaceRef[] };
  return (body.workspaces ?? []).map(({ id, name }) => ({ id, name }));
}

/**
 * Neither hook may fail the run. A cleanup that cannot reach the server is a
 * missing convenience, not a test result.
 */
export async function recordWorkspaceBaseline(): Promise<void> {
  const restoreTls = relaxTls();
  try {
    const token = await issueToken();
    const workspaces = token ? await listWorkspaces(token) : [];
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(workspaces), 'utf8');
  } catch {
    // Leave no baseline; teardown then deletes nothing.
    rmSync(BASELINE_PATH, { force: true });
  } finally {
    restoreTls();
  }
}

export async function removeWorkspacesCreatedDuringRun(): Promise<void> {
  const restoreTls = relaxTls();
  try {
    let before: WorkspaceRef[];
    try {
      before = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as WorkspaceRef[];
    } catch {
      // Without a baseline every workspace would look new. Delete nothing.
      return;
    }

    const token = await issueToken();
    if (!token) return;
    const leaked = workspacesCreatedDuringRun(before, await listWorkspaces(token));
    for (const workspace of leaked) {
      await fetch(`${baseUrl()}/api/workspaces/${workspace.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    if (leaked.length > 0) {
      console.log(`[e2e] removed ${leaked.length} workspace(s) created during the run`);
    }
  } catch {
    // As above: cleanup failure is not a test failure.
  } finally {
    rmSync(BASELINE_PATH, { force: true });
    restoreTls();
  }
}

export default recordWorkspaceBaseline;
