export type TerminalAuthorityDebugNext = () => void;

export type TerminalAuthorityDebugMiddleware = (
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  next: TerminalAuthorityDebugNext,
) => void;

export interface RegisterTerminalAuthorityDebugRoutesOptions {
  registrar: {
    post(path: string, ...handlers: TerminalAuthorityDebugMiddleware[]): void;
  };
  authMiddleware: TerminalAuthorityDebugMiddleware;
  requireLocalDebugCapture: TerminalAuthorityDebugMiddleware;
  requireExistingDebugSession: TerminalAuthorityDebugMiddleware;
  handleTestIsolation: TerminalAuthorityDebugMiddleware;
  handleRollback: TerminalAuthorityDebugMiddleware;
  handleFault: TerminalAuthorityDebugMiddleware;
}

/**
 * Registers the three test-only authority mutation endpoints with one fixed
 * guard order. The handlers own behavior; this adapter owns only routing.
 *
 * @req MIG-BGSTAB-002 AC-6
 */
export function registerTerminalAuthorityDebugRoutes(
  options: RegisterTerminalAuthorityDebugRoutesOptions,
): void {
  const guards = [
    options.authMiddleware,
    options.requireLocalDebugCapture,
    options.requireExistingDebugSession,
  ] as const;
  options.registrar.post(
    '/api/sessions/debug-capture/:id/terminal-authority-test-isolation',
    ...guards,
    options.handleTestIsolation,
  );
  options.registrar.post(
    '/api/sessions/debug-capture/:id/terminal-authority-rollback',
    ...guards,
    options.handleRollback,
  );
  options.registrar.post(
    '/api/sessions/debug-capture/:id/terminal-authority-fault',
    ...guards,
    options.handleFault,
  );
}
