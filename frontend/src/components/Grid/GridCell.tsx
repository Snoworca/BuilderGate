import { DisconnectedOverlay } from '../Workspace/DisconnectedOverlay';
import { MetadataRow } from '../MetadataBar/MetadataRow';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import '../Workspace/breathing.css';

interface Props {
  tab: WorkspaceTabRuntime;
  color: string;
  onRestart: () => void;
  children: React.ReactNode;
}

export function GridCell({ tab, color, onRestart, children }: Props) {
  const isRunning = tab.status === 'running';
  const isDisconnected = tab.status === 'disconnected';

  return (
    <div
      className={`grid-cell${isRunning ? ' terminal-running' : ''}`}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--terminal-bg, #1e1e1e)',
        overflow: 'hidden',
        minWidth: '120px',
        minHeight: '80px',
        '--tab-color': color,
      } as React.CSSProperties}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
      <MetadataRow tab={tab} isOdd={false} />
      {isDisconnected && <DisconnectedOverlay onRestart={onRestart} />}
    </div>
  );
}
