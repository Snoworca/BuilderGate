import { Icon } from '../common';
import { Button } from '../ui';
import './Workspace.css';
import { t } from '../../i18n/i18n.ts';

interface Props {
  onRestart: () => void;
}

export function DisconnectedOverlay({ onRestart }: Props) {
  return (
    <div className="disconnected-overlay">
      <span className="disconnected-overlay-icon">
        <Icon name="alert" size={20} />
      </span>
      <span className="disconnected-overlay-text">{t('workspace.disconnected.ended')}</span>
      <Button variant="primary" size="md" icon="refresh" onClick={onRestart}>
        {t('workspace.disconnected.restart')}
      </Button>
    </div>
  );
}
