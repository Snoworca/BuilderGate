import { resourceLimitsSchema } from '../schemas/config.schema.js';
import type { Config } from '../types/config.types.js';
import { SessionManager } from './SessionManager.js';

type SessionDto = ReturnType<SessionManager['createSession']>;

export interface PublicObservedSessionFixture {
  readonly manager: SessionManager;
  readonly createdSession: SessionDto;
  readonly observedSession: SessionDto | null;
  readonly createCallCount: number;
  readonly spawnCount: number;
  readonly onDataRegistrationCount: number;
  readonly activeDataCallbackCount: number;
  dispose(): boolean;
}

function createFixtureConfig(): Config {
  return {
    server: { port: 4242 },
    pty: {
      termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: false,
      scrollbackLines: 1_000, maxSnapshotBytes: 65_536, shell: 'auto',
    },
    session: { idleDelayMs: 200 },
    resourceLimits: resourceLimitsSchema.parse(undefined),
    stabilityModes: {
      headlessQueueMode: 'observe', wsSendMode: 'safe-send-enforce', frontendRuntimeResidency: 'bounded',
    },
  };
}

export function createPublicObservedSessionFixture(input: {
  sessionId: string;
}): PublicObservedSessionFixture {
  let spawnCount = 0;
  let onDataRegistrationCount = 0;
  let activeDataCallbackCount = 0;
  const disposeDataCallbacks: Array<() => void> = [];
  const config = createFixtureConfig();
  const manager = new SessionManager({
    pty: config.pty,
    session: config.session,
    resourceLimits: config.resourceLimits,
    stabilityModes: config.stabilityModes,
  }, {
    platform: 'win32',
    spawnPty: () => {
      spawnCount += 1;
      return {
        pid: 701,
        cols: 80,
        rows: 24,
        process: 'powershell.exe',
        handleFlowControl: false,
        onData() {
          onDataRegistrationCount += 1;
          activeDataCallbackCount += 1;
          let released = false;
          const dispose = () => {
            if (!released) {
              released = true;
              activeDataCallbackCount -= 1;
            }
          };
          disposeDataCallbacks.push(dispose);
          return { dispose };
        },
        onExit() { return { dispose() {} }; },
        write() {},
        pause() {},
        resize() {},
        kill() {},
      };
    },
  } as ConstructorParameters<typeof SessionManager>[1]);
  let createCallCount = 0;
  const createPublicSession = (): SessionDto => {
    createCallCount += 1;
    return manager.createSession(input.sessionId, 'powershell', process.cwd(), {
      sessionId: input.sessionId,
    });
  };
  const createdSession = createPublicSession();
  const observedSession = manager.getSession(createdSession.id);
  if (!observedSession) throw new Error(`fixture session ${createdSession.id} was not publicly observable`);
  let disposed = false;

  return {
    manager,
    createdSession,
    observedSession,
    get createCallCount() { return createCallCount; },
    get spawnCount() { return spawnCount; },
    get onDataRegistrationCount() { return onDataRegistrationCount; },
    get activeDataCallbackCount() { return activeDataCallbackCount; },
    dispose() {
      if (disposed) return false;
      disposed = true;
      const deleted = manager.deleteSession(createdSession.id);
      if (!deleted) throw new Error(`fixture session ${createdSession.id} was not deleted`);
      for (const disposeDataCallback of disposeDataCallbacks) disposeDataCallback();
      if (manager.getSession(createdSession.id)) {
        throw new Error(`fixture session ${createdSession.id} remained publicly visible after cleanup`);
      }
      if (activeDataCallbackCount !== 0) {
        throw new Error(`fixture session ${createdSession.id} retained ${activeDataCallbackCount} PTY callbacks`);
      }
      return true;
    },
  };
}
