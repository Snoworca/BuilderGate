import './TerminalBadges.css';

interface Props {
  running: number;
  idle: number;
}

export function TerminalBadges({ running, idle }: Props) {
  if (running === 0 && idle === 0) return null;

  return (
    <div className="terminal-badges">
      {idle > 0 && (
        <span className="terminal-badge badge-idle" title={`${idle} idle`}>
          {idle}
        </span>
      )}
      {running > 0 && (
        <span className="terminal-badge badge-running" title={`${running} running`}>
          {running}
        </span>
      )}
    </div>
  );
}
