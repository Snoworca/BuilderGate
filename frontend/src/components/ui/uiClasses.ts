// The class rules the shared parts apply (FR-UIDS-002).
//
// Kept apart from the components so they are values a test can read without a
// DOM or a stylesheet: which variant a button is, which tone a chip carries.

export const BUTTON_VARIANTS = ['primary', 'secondary', 'danger', 'danger-text'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export const BUTTON_SIZES = ['sm', 'md', 'lg'] as const;
export type ButtonSize = (typeof BUTTON_SIZES)[number];

export const CHIP_TONES = ['neutral', 'accent', 'ok', 'warn', 'danger'] as const;
export type ChipTone = (typeof CHIP_TONES)[number];

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function buttonClassName(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  return join('ui-button', `ui-button-${variant}`, `ui-button-${size}`, extra);
}

export function chipClassName(tone: ChipTone, extra?: string): string {
  return join('ui-chip', `ui-chip-${tone}`, extra);
}

/** Whether a string holds Hangul — the test FR-UIDS-003 applies to copy. */
export function containsHangul(value: string): boolean {
  return /[ㄱ-ㆎ가-힣]/.test(value);
}

export { join as joinClassNames };
