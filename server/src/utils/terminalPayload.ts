export function findSafeTerminalPayloadStart(data: string, start: number): number {
  if (start <= 0) {
    return 0;
  }

  let index = 0;
  while (index < data.length) {
    if (data[index] === '\x1b') {
      const next = consumeEscapeSequence(data, index);
      if (index >= start) {
        return next.complete ? index : data.length;
      }
      index = next.nextIndex;
      continue;
    }

    if (index >= start) {
      return index;
    }

    index += 1;
  }

  return data.length;
}

export function truncateTerminalPayloadTail(
  data: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { content: '', truncated: data.length > 0 };
  }

  if (Buffer.byteLength(data, 'utf8') <= maxBytes) {
    return { content: data, truncated: false };
  }

  const byteBoundedStart = findByteBoundedStart(data, maxBytes);
  const safeStart = findSafeTerminalPayloadStart(data, byteBoundedStart);
  let content = trimTrailingIncompleteEscapeSequence(data.slice(safeStart));
  let nextStart = safeStart;
  while (Buffer.byteLength(content, 'utf8') > maxBytes && nextStart < data.length) {
    nextStart = findSafeTerminalPayloadStart(data, nextStart + 1);
    content = trimTrailingIncompleteEscapeSequence(data.slice(nextStart));
  }

  return {
    content,
    truncated: true,
  };
}

function findByteBoundedStart(data: string, maxBytes: number): number {
  let low = 0;
  let high = data.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(data.slice(mid), 'utf8') > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return moveToCodePointBoundary(data, low);
}

function moveToCodePointBoundary(data: string, index: number): number {
  if (
    index > 0
    && index < data.length
    && isLowSurrogate(data.charCodeAt(index))
    && isHighSurrogate(data.charCodeAt(index - 1))
  ) {
    return index + 1;
  }

  return index;
}

function isHighSurrogate(charCode: number): boolean {
  return charCode >= 0xD800 && charCode <= 0xDBFF;
}

function isLowSurrogate(charCode: number): boolean {
  return charCode >= 0xDC00 && charCode <= 0xDFFF;
}

function consumeEscapeSequence(data: string, start: number): { nextIndex: number; complete: boolean } {
  const marker = data[start + 1];
  if (!marker) {
    return { nextIndex: data.length, complete: false };
  }

  if (marker === '[') {
    return consumeUntilFinal(data, start + 2, /[@-~]/);
  }

  if (marker === ']') {
    return consumeOsc(data, start + 2);
  }

  if (marker === 'P' || marker === '^' || marker === '_') {
    return consumeStringTerminatedSequence(data, start + 2);
  }

  return { nextIndex: Math.min(start + 2, data.length), complete: true };
}

function consumeUntilFinal(data: string, start: number, finalByte: RegExp): { nextIndex: number; complete: boolean } {
  for (let index = start; index < data.length; index += 1) {
    if (finalByte.test(data[index])) {
      return { nextIndex: index + 1, complete: true };
    }
  }

  return { nextIndex: data.length, complete: false };
}

function consumeOsc(data: string, start: number): { nextIndex: number; complete: boolean } {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === '\u0007') {
      return { nextIndex: index + 1, complete: true };
    }

    if (data[index] === '\x1b' && data[index + 1] === '\\') {
      return { nextIndex: Math.min(index + 2, data.length), complete: true };
    }
  }

  return { nextIndex: data.length, complete: false };
}

function consumeStringTerminatedSequence(data: string, start: number): { nextIndex: number; complete: boolean } {
  for (let index = start; index < data.length - 1; index += 1) {
    if (data[index] === '\x1b' && data[index + 1] === '\\') {
      return { nextIndex: index + 2, complete: true };
    }
  }

  return { nextIndex: data.length, complete: false };
}

function trimTrailingIncompleteEscapeSequence(data: string): string {
  let index = 0;
  while (index < data.length) {
    if (data[index] !== '\x1b') {
      index += 1;
      continue;
    }

    const escape = consumeEscapeSequence(data, index);
    if (!escape.complete) {
      return data.slice(0, index);
    }

    index = escape.nextIndex;
  }

  return data;
}
