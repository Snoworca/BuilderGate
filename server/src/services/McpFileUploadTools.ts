// FR-MCP-021 (#234): buildergate.file.upload_url opens a one-use upload URL for a session's working
// folder (mcpFileUpload.ts serves it at /mcp/fu).

type Rec = Record<string, unknown>;

/** What McpToolService needs from the upload URLs (implemented by mcpFileUpload.ts). */
export interface McpFileUploadPort {
  open(sessionId: string): Promise<Rec>;
}

export const MCP_FILE_UPLOAD_TOOL = 'buildergate.file.upload_url';

export const MCP_FILE_UPLOAD_TOOL_SCHEMA: Rec = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'The session whose working folder receives the file. Its folder now is used, even if the session moves later.' },
  },
  required: ['sessionId'],
  additionalProperties: false,
};

export const MCP_FILE_UPLOAD_TOOL_DESCRIPTION = 'Open a one-use upload URL that puts one file into a session\'s current working folder. '
  + 'Upload with: curl -T <file> "<url>&name=<file name>" (PUT or POST, or open the URL in a browser). The URL works once: '
  + 'after the first upload request it is gone, whether that upload finished, failed or was cut off; unused, it expires in 10 minutes. '
  + 'A file whose name is taken is saved under a new name. Needs the submit scope.';

/** FR-MCP-021 AC-1/AC-2. origin: the address the MCP request came to, if known. */
export async function callMcpFileUploadTool(
  port: McpFileUploadPort | undefined,
  actor: Rec,
  args: Rec,
  origin: string | undefined,
): Promise<Rec> {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  if (!scopes.includes('mcp:message.submit')) return { ok: false, code: 'INVALID_SCOPE' };
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!sessionId) return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { sessionId: 'required' } };
  if (!port) return { ok: false, code: 'MCP_FILE_UPLOAD_UNAVAILABLE' };
  const opened = await port.open(sessionId);
  if (opened.ok !== true) return opened;
  const urlPath = String(opened.path);
  const url = origin ? `${origin.replace(/\/+$/u, '')}${urlPath}` : undefined;
  return {
    ...opened,
    ...(url ? { url } : {}),
    usage: `curl -T <file> "${url ?? urlPath}&name=<file name>"`,
  };
}
