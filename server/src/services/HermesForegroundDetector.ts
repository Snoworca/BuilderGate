import type {
  ForegroundAppDetector,
  ForegroundAppDetectorInput,
  ForegroundAppObservation,
} from './ForegroundAppDetector.js';

const MAX_RECENT_TEXT_CHARS = 2048;
const MAX_RECENT_RAW_CHARS = 4096;
const HERMES_VERSION_RE = /\bHermes Agent v[\w().-]+/i;
const CPR_WARNING_RE = /terminal doesn't support cursor position requests \(CPR\)/i;
const CURSOR_REQUEST_RE = /\x1b\[6n/;
const CURSOR_MOTION_RE = /\x1b\[[0-9;?]*[ABCDHJKfhlmnpsu]/;
const HERMES_WELCOME_RE = /Welcome to Hermes Agent!/i;
const HERMES_TIP_RE = /(?:✦|\?) Tip:/i;
const HERMES_MODEL_RE = /\bclaude-[a-z0-9.\-]+\b/i;
const HERMES_BANNER_RE = /██╗\s+██╗|███████╗|██╔════╝/;
const DECORATIVE_FRAME_RE = /^[\s─╰╯│]+$/;

export class HermesForegroundDetector implements ForegroundAppDetector {
  readonly id = 'hermes';

  private attached = false;
  private recentText = '';
  private recentRaw = '';

  inspect(input: ForegroundAppDetectorInput): ForegroundAppObservation | null {
    this.recentRaw = appendTail(this.recentRaw, input.chunk, MAX_RECENT_RAW_CHARS);
    const cleanedChunk = stripTerminalControlSequences(input.chunk);
    this.recentText = appendTail(this.recentText, cleanedChunk, MAX_RECENT_TEXT_CHARS);
    const normalized = cleanedChunk.replace(/\r\n?/g, '\n');
    const trimmed = normalized.trim();

    const bootstrapActivity = this.classifyBootstrapActivity(input, normalized, trimmed);

    if (!this.attached && this.shouldAttach(input, this.recentText, this.recentRaw, trimmed, bootstrapActivity)) {
      this.attached = true;
      return {
        detectorId: this.id,
        appId: 'hermes',
        activity: bootstrapActivity ?? 'waiting_input',
        reason: input.appHint === 'hermes' ? 'hermes_command_hint' : 'hermes_bootstrap_detected',
        confidence: 'medium',
        details: {
          detectionMode: input.detectionMode,
          shellType: input.shellType ?? null,
          bootstrapActivity: bootstrapActivity ?? 'waiting_input',
        },
      };
    }

    if (!this.attached) {
      return null;
    }

    if (bootstrapActivity) {
      return {
        detectorId: this.id,
        appId: 'hermes',
        activity: bootstrapActivity,
        reason: bootstrapActivity === 'repaint_only' ? 'status_repaint' : 'bootstrap_waiting_input',
        confidence: 'high',
      };
    }

    if (this.isSemanticBusy(input.chunk, normalized, trimmed)) {
      return {
        detectorId: this.id,
        appId: 'hermes',
        activity: 'busy',
        reason: 'semantic_output',
        confidence: 'medium',
        details: {
          printableLength: trimmed.length,
          lineCount: countNonEmptyLines(normalized),
        },
      };
    }

    if (this.isRepaintOnly(input.chunk, trimmed)) {
      return {
        detectorId: this.id,
        appId: 'hermes',
        activity: 'repaint_only',
        reason: CURSOR_REQUEST_RE.test(input.chunk) ? 'cursor_position_request' : 'status_repaint',
        confidence: 'high',
      };
    }

    return null;
  }

  reset(): void {
    this.attached = false;
    this.recentText = '';
    this.recentRaw = '';
  }

  private shouldAttach(
    input: ForegroundAppDetectorInput,
    cleanedText: string,
    rawText: string,
    trimmedChunk: string,
    bootstrapActivity: 'waiting_input' | 'repaint_only' | null,
  ): boolean {
    return (
      input.appHint === 'hermes' &&
      (bootstrapActivity !== null ||
        this.isHintedHermesBootstrap(rawText, trimmedChunk) ||
        this.isHintedHermesBootstrap(cleanedText, cleanedText))
    );
  }

  private classifyBootstrapActivity(
    input: ForegroundAppDetectorInput,
    normalizedChunk: string,
    trimmedChunk: string,
  ): 'waiting_input' | 'repaint_only' | null {
    if (this.isRepaintOnly(input.chunk, trimmedChunk)) {
      return 'repaint_only';
    }

    if (!trimmedChunk) {
      return null;
    }

    if (this.isLikelyInteractiveTypingEcho(input, normalizedChunk, trimmedChunk)) {
      return 'waiting_input';
    }

    if (this.isDecorativeFrame(trimmedChunk)) {
      return 'repaint_only';
    }

    if (
      HERMES_WELCOME_RE.test(trimmedChunk) ||
      HERMES_TIP_RE.test(trimmedChunk) ||
      this.isStatusFrame(trimmedChunk) ||
      (input.appHint === 'hermes' && this.isHintedHermesBootstrap(input.chunk, trimmedChunk)) ||
      (input.appHint === 'hermes' && this.isLargeBootstrapClearFrame(input.chunk, normalizedChunk))
    ) {
      return 'waiting_input';
    }

    return null;
  }

  private isSemanticBusy(rawChunk: string, normalizedChunk: string, trimmedChunk: string): boolean {
    if (!trimmedChunk) {
      return false;
    }

    if (HERMES_VERSION_RE.test(trimmedChunk) || HERMES_WELCOME_RE.test(trimmedChunk) || CPR_WARNING_RE.test(trimmedChunk)) {
      return false;
    }

    if (this.isLikelyTicker(trimmedChunk, rawChunk)) {
      return false;
    }

    if (this.isDecorativeFrame(trimmedChunk)) {
      return false;
    }

    const lineCount = countNonEmptyLines(normalizedChunk);
    if (lineCount >= 1 && /[A-Za-z]/.test(trimmedChunk)) {
      return true;
    }
    return lineCount >= 2 && trimmedChunk.length >= 12;
  }

  private isRepaintOnly(rawChunk: string, trimmedChunk: string): boolean {
    if (CURSOR_REQUEST_RE.test(rawChunk) || CPR_WARNING_RE.test(trimmedChunk)) {
      return true;
    }

    if (!trimmedChunk) {
      return containsTerminalMotion(rawChunk);
    }

    return this.isLikelyTicker(trimmedChunk, rawChunk);
  }

  private isLikelyTicker(trimmedChunk: string, rawChunk: string): boolean {
    if (!containsTerminalMotion(rawChunk)) {
      return false;
    }

    return (
      /^\d+$/.test(trimmedChunk) ||
      /^\d+[smhd]$/i.test(trimmedChunk) ||
      /^\d{1,2}:\d{2}$/.test(trimmedChunk) ||
      (trimmedChunk.length <= 4 && /^[0-9:]+$/.test(trimmedChunk))
    );
  }

  private isStatusFrame(trimmedChunk: string): boolean {
    const compact = trimmedChunk.replace(/\s+/g, ' ');
    return (
      compact.includes('❯') ||
      (compact.includes('│') && compact.toLowerCase().includes('ctx')) ||
      HERMES_MODEL_RE.test(compact)
    );
  }

  private isDecorativeFrame(trimmedChunk: string): boolean {
    return DECORATIVE_FRAME_RE.test(trimmedChunk);
  }

  private isHintedHermesBootstrap(rawChunk: string, trimmedChunk: string): boolean {
    return (
      HERMES_BANNER_RE.test(rawChunk) ||
      HERMES_WELCOME_RE.test(trimmedChunk) ||
      HERMES_TIP_RE.test(trimmedChunk) ||
      this.isStatusFrame(trimmedChunk)
    );
  }

  private isLikelyInteractiveTypingEcho(
    input: ForegroundAppDetectorInput,
    normalizedChunk: string,
    trimmedChunk: string,
  ): boolean {
    const lineCount = countNonEmptyLines(normalizedChunk);
    const msSinceLastInput = input.msSinceLastInput ?? null;
    return (
      input.lastInputHasEnter === false &&
      msSinceLastInput !== null &&
      msSinceLastInput < 250 &&
      lineCount === 1 &&
      trimmedChunk.length <= 32
    );
  }

  private isLikelyCommandEcho(trimmedChunk: string, lastSubmittedCommand?: string): boolean {
    const normalizedChunk = trimmedChunk.replace(/\s+/g, ' ').trim();
    if (detectHermesCommandFromChunk(normalizedChunk)) {
      return true;
    }

    if (!lastSubmittedCommand) {
      return false;
    }

    const normalizedCommand = lastSubmittedCommand.replace(/\s+/g, ' ').trim();
    return normalizedChunk === normalizedCommand || normalizedChunk.endsWith(normalizedCommand);
  }

  private isLargeBootstrapClearFrame(rawChunk: string, normalizedChunk: string): boolean {
    return rawChunk.includes('\x1b[2J') && countNonEmptyLines(normalizedChunk) === 0;
  }
}

function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function appendTail(existing: string, chunk: string, maxChars: number): string {
  const next = `${existing}${chunk}`;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(next.length - maxChars);
}

function containsTerminalMotion(raw: string): boolean {
  return CURSOR_MOTION_RE.test(raw) || /\x1b\[[0-9;]*m/.test(raw);
}

function countNonEmptyLines(value: string): number {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

function detectHermesCommandFromChunk(value: string): boolean {
  const promptStripped = value.replace(/^.*?[>$#]\s+/, '');
  const firstToken = promptStripped.split(/\s+/)[0]?.toLowerCase() ?? '';
  return firstToken === 'hermes' || firstToken.endsWith('/hermes') || firstToken.endsWith('\\hermes');
}
