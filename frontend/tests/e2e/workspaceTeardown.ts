import { removeWorkspacesCreatedDuringRun } from './workspaceLeakGuard.ts';

export default async function teardown(): Promise<void> {
  await removeWorkspacesCreatedDuringRun();
}
