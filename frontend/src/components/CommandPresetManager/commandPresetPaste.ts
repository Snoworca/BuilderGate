import type { CommandPreset, CommandPresetKind } from '../../types';

export type CommandPresetPasteFailureReason =
  | 'empty-value'
  | 'multiline-command'
  | 'multiline-directory'
  | 'unsafe-multiline-prompt'
  | 'control-character';

export type CommandPresetPasteValidationResult =
  | { ok: true; data: string }
  | { ok: false; reason: CommandPresetPasteFailureReason };

export function buildCommandPresetPasteInput(
  preset: Pick<CommandPreset, 'kind' | 'value'>,
): CommandPresetPasteValidationResult {
  if (preset.value.trim().length === 0) {
    return { ok: false, reason: 'empty-value' };
  }

  if (preset.kind !== 'prompt' && hasLineBreak(preset.value)) {
    return { ok: false, reason: getMultilineFailureReason(preset.kind) };
  }

  if (hasControlCharacter(preset.value, { allowLineBreaks: preset.kind === 'prompt' })) {
    return { ok: false, reason: 'control-character' };
  }

  return { ok: true, data: preset.value };
}

function getMultilineFailureReason(kind: CommandPresetKind): CommandPresetPasteFailureReason {
  if (kind === 'command') {
    return 'multiline-command';
  }
  if (kind === 'directory') {
    return 'multiline-directory';
  }
  return 'unsafe-multiline-prompt';
}

function hasLineBreak(value: string): boolean {
  return value.includes('\r') || value.includes('\n');
}

function hasControlCharacter(value: string, options: { allowLineBreaks: boolean }): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (options.allowLineBreaks && (code === 0x0a || code === 0x0d)) {
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
