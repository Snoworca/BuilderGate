// Shared observation shape for the grid and authority browser captures.
export type CapturedWsMessage = {
  direction?: 'in' | 'out';
  type?: string;
  sessionId?: string;
  mode?: string;
  data?: string;
  replayToken?: string;
  connectionEpoch?: string;
  deliverySeq?: number;
  repairToken?: string;
  seq?: number;
  cols?: number;
  rows?: number;
  reason?: string;
  clientAtBottom?: boolean;
  clientBufferType?: string;
  bufferType?: string;
  source?: string;
  cursor?: { x?: number; y?: number; hidden?: boolean };
  viewportRows?: Array<{ y?: number; text?: string; ansi?: string; wrapped?: boolean }>;
  ansiPatch?: string;
};
