import { WindowDialog } from '../dialog';
import { Button, DialogFooter } from '../ui';
import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildWorkspaceMoveTargets,
  type WorkspaceMoveTarget,
} from './workspaceMoveTargets';
import './WorkspaceMoveDialog.css';

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
  if (target.reason === 'current') return '현재 Workspace';
  if (target.reason === 'full') return '탭이 가득 참';
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
      title="Workspace 이동"
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
          이 탭을 옮길 Workspace를 고르세요. 누르는 즉시 옮겨지며, 탭에서 실행 중인 세션은 그대로 이어집니다.
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
                {target.reason ? reasonLabel(target) : `탭 ${target.tabCount}/${maxTabsPerWorkspace}개`}
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
      <DialogFooter note={moving ? '옮기는 중입니다.' : undefined}>
        <Button variant="secondary" onClick={onClose} disabled={moving}>
          취소
        </Button>
      </DialogFooter>
    </WindowDialog>
  );
}

export { buildWorkspaceMoveTargets } from './workspaceMoveTargets';
