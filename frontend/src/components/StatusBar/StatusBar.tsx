import './StatusBar.css';

interface Props {
  connected: boolean;
  sessionName?: string;
  prefixMode?: boolean;
  isZoomed?: boolean;
  paneInfo?: { current: number; total: number };
  statusMessage?: string | null;
}

export function StatusBar({ connected, sessionName, prefixMode, isZoomed, paneInfo, statusMessage }: Props) {
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
          <span className="status-dot" />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
        {prefixMode && <span className="status-prefix">[PREFIX]</span>}
        {isZoomed && <span className="status-zoomed">[ZOOMED]</span>}
        {paneInfo && paneInfo.total > 1 && (
          <span className="status-pane-info">Pane {paneInfo.current}/{paneInfo.total}</span>
        )}
        {statusMessage && <span className="status-message">{statusMessage}</span>}
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
