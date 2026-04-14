export function isLikelyBlankTerminalText(raw: string): boolean {
  return raw.replace(/\u00a0/g, ' ').trim().length === 0;
}

export function isLikelyCorruptedIdleTerminalText(raw: string): boolean {
  const normalized = raw
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n');

  const nonEmptyLines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (nonEmptyLines.length === 0) return false;

  const uniqueLines = Array.from(new Set(nonEmptyLines));
  if (uniqueLines.length !== 1) {
    return false;
  }

  const singleLine = uniqueLines[0];
  const isPromptLike =
    /^PS [^>]+>$/.test(singleLine) ||
    /^[A-Z]:\\.*>$/.test(singleLine) ||
    /^>_ /.test(singleLine);

  return isPromptLike && nonEmptyLines.length >= 3;
}
