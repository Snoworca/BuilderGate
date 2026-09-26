// REL-BGSTAB-022 AC-4: node-pty 1.1.0 kills a ConPTY session by forking an
// agent that attaches to the console of the shell PID and lists every process
// on it, then calls process.kill on each one from the server. The verified tree
// kill has usually taken the shell already, and Windows may have handed its PID
// to a PowerShell helper the server just started -- whose console is the
// server's. The list then holds the server, and the server kills itself.

interface ConsoleListAgent {
  _getConsoleProcessList?: () => Promise<number[]>;
}

/**
 * Drops `protectedPids` from the list node-pty's ConPTY kill() is about to
 * kill. Returns false, touching nothing, for a PTY without that agent (POSIX,
 * winpty, or a node-pty whose internals changed).
 */
export function guardPtyConsoleKill(
  pty: unknown,
  protectedPids: readonly number[],
  onDropped?: (dropped: number[]) => void,
): boolean {
  const agent = (pty as { _agent?: ConsoleListAgent } | null)?._agent;
  const original = agent?._getConsoleProcessList;
  if (!agent || typeof original !== 'function') return false;
  const guarded = new Set(protectedPids.filter(pid => Number.isInteger(pid) && pid > 0));
  agent._getConsoleProcessList = function guardedConsoleProcessList(this: ConsoleListAgent) {
    return original.call(this).then((list) => {
      const dropped = list.filter(pid => guarded.has(pid));
      if (dropped.length > 0) onDropped?.(dropped);
      return dropped.length > 0 ? list.filter(pid => !guarded.has(pid)) : list;
    });
  };
  return true;
}
