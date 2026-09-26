import { Icon } from '../common';
import { Button } from '../ui';
import './Workspace.css';

interface Props {
  onRestart: () => void;
}

export function DisconnectedOverlay({ onRestart }: Props) {
  return (
    <div className="disconnected-overlay">
      <span className="disconnected-overlay-icon">
        <Icon name="alert" size={20} />
      </span>
      <span className="disconnected-overlay-text">세션이 종료되었습니다</span>
      <Button variant="primary" size="md" icon="refresh" onClick={onRestart}>
        재시작
      </Button>
    </div>
  );
}
