export type SessionOwnership = 'shell_prompt' | 'foreground_app';

export type SessionActivity = 'busy' | 'waiting_input' | 'repaint_only' | 'unknown';

export type DerivedDisplayStatus = 'running' | 'idle';

export type SessionShellType = 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd';

export type DetectionMode = 'heuristic' | 'osc133';

export type ForegroundDetectorDebugValue = string | number | boolean | null;

export interface SessionDerivedState {
  ownership: SessionOwnership;
  activity: SessionActivity;
  foregroundAppId?: string;
  detectorId?: string;
  lastObservationAt?: number;
  lastSemanticOutputAt?: number;
  lastRepaintOnlyAt?: number;
}

export interface ForegroundAppDetectorInput {
  chunk: string;
  now: number;
  sessionId: string;
  shellType?: SessionShellType;
  detectionMode: DetectionMode;
  appHint?: string;
  lastSubmittedCommand?: string;
  lastInputHasEnter?: boolean;
  msSinceLastInput?: number | null;
}

export interface ForegroundAppObservation {
  detectorId: string;
  appId: string;
  activity: Exclude<SessionActivity, 'unknown'>;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  details?: Record<string, ForegroundDetectorDebugValue>;
}

export interface ForegroundAppDetector {
  readonly id: string;
  inspect(input: ForegroundAppDetectorInput): ForegroundAppObservation | null;
  reset(): void;
}

export class ForegroundAppDetectorRegistry {
  constructor(private readonly detectors: ForegroundAppDetector[]) {}

  inspect(input: ForegroundAppDetectorInput): ForegroundAppObservation | null {
    for (const detector of this.detectors) {
      const observation = detector.inspect(input);
      if (observation) {
        return observation;
      }
    }
    return null;
  }

  reset(): void {
    for (const detector of this.detectors) {
      detector.reset();
    }
  }
}

export function createInitialDerivedState(): SessionDerivedState {
  return {
    ownership: 'shell_prompt',
    activity: 'waiting_input',
  };
}

export function deriveDisplayStatus(state: SessionDerivedState): DerivedDisplayStatus {
  if (state.ownership === 'shell_prompt') {
    return 'idle';
  }

  if (state.activity === 'waiting_input' || state.activity === 'repaint_only') {
    return 'idle';
  }

  return 'running';
}
