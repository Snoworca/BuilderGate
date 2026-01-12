import type { SessionStatus } from '../../types';
import './StatusIndicator.css';

interface Props {
  status: SessionStatus;
}

export function StatusIndicator({ status }: Props) {
  return (
    <span
      className={`status-indicator ${status}`}
      title={status === 'running' ? 'Running' : 'Idle'}
    />
  );
}
