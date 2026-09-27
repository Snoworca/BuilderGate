import { WindowDialog } from '../dialog';
import { Button, DialogFooter } from '../ui';
import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildWorkspaceMoveTargets,
  type WorkspaceMoveTarget,
} from './workspaceMoveTargets';
import './WorkspaceMoveDialog.css';
import { t } from '../../i18n/i18n.ts';

interface WorkspaceMoveDialogProps {
  open: boolean;
  workspaces: Workspace[];
  tabs: WorkspaceTabRuntime[];
  sourceWorkspaceId: string;
  maxTabsPerWorkspace: number;
  moving: boolean;
  error: string | null;
  onMove: (targetWorkspaceId: string) => void;
  onClose: () => void;
}

function reasonLabel(target: WorkspaceMoveTarget): string {
  if (target.reason === 'current') return t('workspace.move.reason.current');
  if (target.reason === 'full') return t('workspace.move.reason.full');
  return '';
}

export function WorkspaceMoveDialog({
  open,
  workspaces,
  tabs,
  sourceWorkspaceId,
  maxTabsPerWorkspace,
  moving,
  error,
  onMove,
  onClose,
}: WorkspaceMoveDialogProps) {
  if (!open) {
    return null;
  }

  const targets = buildWorkspaceMoveTargets({
    workspaces,
    tabs,
    sourceWorkspaceId,
    maxTabsPerWorkspace,
  });

  return (
    <WindowDialog
      dialogId="workspace-move-dialog"
      title={t('workspace.move.title')}
      mode="modal"
      defaultRect={{ x: 240, y: 120, width: 440, height: 460 }}
      minSize={{ width: 360, height: 320 }}
      onClose={moving ? () => undefined : onClose}
      showCloseButton={!moving}
      resizable={false}
      persistGeometry={false}
      surfaceClassName="workspace-move-dialog-surface"
    >
      <div className="workspace-move-dialog">
        <p className="workspace-move-description">
          {t('workspace.move.intro')}
        </p>
        <div className="workspace-move-targets">
          {targets.map((target) => (
            <button
              key={target.workspace.id}
              type="button"
              className="workspace-move-target"
              disabled={moving || target.disabled}
              onClick={() => onMove(target.workspace.id)}
            >
              <span className="workspace-move-target-name">
                {target.workspace.name}
              </span>
              <span className="workspace-move-target-meta">
                {target.reason ? reasonLabel(target) : t('workspace.move.tabCount', { count: target.tabCount, max: maxTabsPerWorkspace })}
              </span>
            </button>
          ))}
        </div>

        {error && (
          <div className="workspace-move-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <DialogFooter note={moving ? t('workspace.move.moving') : undefined}>
        <Button variant="secondary" onClick={onClose} disabled={moving}>
          {t('common.cancel')}
        </Button>
      </DialogFooter>
    </WindowDialog>
  );
}

export { buildWorkspaceMoveTargets } from './workspaceMoveTargets';
