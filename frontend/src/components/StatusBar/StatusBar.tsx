import './StatusBar.css';

interface Props {
  connected: boolean;
  sessionName?: string;
}

export function StatusBar({ connected, sessionName }: Props) {
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
          <span className="status-dot" />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div className="statusbar-right">
        {sessionName && (
          <span className="current-session">
            {sessionName}
          </span>
        )}
      </div>
    </footer>
  );
}
