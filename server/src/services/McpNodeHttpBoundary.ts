import crypto from 'node:crypto';

type StringRecord = Record<string, unknown>;

export const MAX_MCP_REQUEST_BODY_BYTES = 1024 * 1024;
export const MCP_REQUEST_TOO_LARGE = 'MCP_REQUEST_TOO_LARGE';

export class McpRequestBodyTooLargeError extends Error {
  readonly code = MCP_REQUEST_TOO_LARGE;
  readonly status = 413;

  constructor() {
    super('MCP request body too large');
  }
}

export async function readMcpIncomingRequestBody(
  stream: AsyncIterable<unknown>,
  maxBytes = MAX_MCP_REQUEST_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new McpRequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function buildMcpNodeRequestErrorResponse(
  error: unknown,
  createAuditId: () => string = () => `audit_${crypto.randomUUID()}`,
): StringRecord {
  const auditId = createAuditId();
  if (isMcpRequestBodyTooLargeError(error)) {
    return {
      status: 413,
      contentType: 'application/json; charset=utf-8',
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: MCP_REQUEST_TOO_LARGE,
          data: { code: MCP_REQUEST_TOO_LARGE, auditId },
        },
      },
    };
  }
  return {
    status: 500,
    contentType: 'application/json; charset=utf-8',
    body: {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: 'Internal error',
        data: { code: 'MCP_REQUEST_FAILED', auditId },
      },
    },
  };
}

export function isMcpRequestBodyTooLargeError(error: unknown): boolean {
  return error instanceof McpRequestBodyTooLargeError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === MCP_REQUEST_TOO_LARGE);
}
