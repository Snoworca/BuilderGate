/* eslint-disable no-control-regex */
export interface TerminalQueryReplyClassificationOptions {
  provenance: 'parser-generated' | 'user-input';
}


const CSI_REPLY_PATTERN = /\x1b\[(?:\??[0-9]+;[0-9]+R|(?:\?|>)[0-9]+(?:;[0-9]+)*c|[0-9]+n|\?[0-9]+(?:;[0-9]+)+n|\??[0-9]+;[0-9]+\$y|[468];[0-9]+;[0-9]+t|\?[0-9]+u)/u;
const OSC_COLOR_REPLY_PATTERN = /\x1b\](?:4;[0-9]+|10|11|12);rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\)/u;
const DCS_REPLY_PATTERN = /\x1bP(?:[01]\$r[^\x1b]*|>\|[^\x1b]*)\x1b\\/u;

// @req MIG-BGSTAB-002 AC-3
export function isTerminalQueryReply(
  data: string,
  options: TerminalQueryReplyClassificationOptions,
): boolean {
  if (options.provenance !== 'parser-generated' || data.length === 0) return false;
  return CSI_REPLY_PATTERN.test(data) && data.match(CSI_REPLY_PATTERN)?.[0] === data
    || OSC_COLOR_REPLY_PATTERN.test(data) && data.match(OSC_COLOR_REPLY_PATTERN)?.[0] === data
    || DCS_REPLY_PATTERN.test(data) && data.match(DCS_REPLY_PATTERN)?.[0] === data;
}
