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
  maxLength: number,
): { content: string; truncated: boolean } {
  if (data.length <= maxLength) {
    return { content: data, truncated: false };
  }

  const safeStart = findSafeTerminalPayloadStart(data, data.length - maxLength);
  return {
    content: trimTrailingIncompleteEscapeSequence(data.slice(safeStart)),
    truncated: true,
  };
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
