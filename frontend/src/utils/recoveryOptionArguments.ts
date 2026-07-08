// @req FR-AITUI-001
export function formatRecoveryDraftArguments(argumentsList: string[]): string {
  return argumentsList.map(quoteRecoveryDraftArgument).join(' ');
}

// @req FR-AITUI-001
export function parseRecoveryDraftArguments(value: string): string[] {
  const argumentsList: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        hasToken = true;
        continue;
      }
      if (quote === '"' && char === '\\' && (value[index + 1] === '"' || value[index + 1] === '\\')) {
        current += value[index + 1];
        index += 1;
        hasToken = true;
        continue;
      }
      current += char;
      hasToken = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        argumentsList.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (hasToken) {
    argumentsList.push(current);
  }
  return argumentsList;
}

// @req FR-AITUI-001
function quoteRecoveryDraftArgument(argument: string): string {
  if (!argument) {
    return '""';
  }
  if (!/[\s"']/.test(argument)) {
    return argument;
  }
  return `"${argument.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
