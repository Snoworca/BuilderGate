import { WindowDialog } from '../dialog';
import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildWorkspaceMoveTargets,
  type WorkspaceMoveTarget,
} from './workspaceMoveTargets';

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
  if (target.reason === 'current') return '현재 워크스페이스';
  if (target.reason === 'full') return '가득 참';
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
      title="워크스페이스 이동"
      mode="modal"
      defaultRect={{ x: 240, y: 120, width: 420, height: 460 }}
      minSize={{ width: 360, height: 320 }}
      onClose={moving ? () => undefined : onClose}
      showCloseButton={!moving}
      resizable={false}
      persistGeometry={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' }}>
          {targets.map((target) => (
            <button
              key={target.workspace.id}
              type="button"
              disabled={moving || target.disabled}
              onClick={() => onMove(target.workspace.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                width: '100%',
                padding: '10px 12px',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.04)',
                color: '#e5e7eb',
                cursor: moving || target.disabled ? 'not-allowed' : 'pointer',
                opacity: target.disabled ? 0.45 : 1,
                textAlign: 'left',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {target.workspace.name}
              </span>
              <span style={{ color: '#9ca3af', fontSize: '12px', flexShrink: 0 }}>
                {target.reason ? reasonLabel(target) : `${target.tabCount}/${maxTabsPerWorkspace}`}
              </span>
            </button>
          ))}
        </div>

        {error && (
          <div style={{ color: '#fca5a5', fontSize: '12px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={moving}
            style={{
              padding: '6px 12px',
              border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: '4px',
              background: 'rgba(255,255,255,0.06)',
              color: '#e5e7eb',
              cursor: moving ? 'not-allowed' : 'pointer',
            }}
          >
            취소
          </button>
        </div>
      </div>
    </WindowDialog>
  );
}

export { buildWorkspaceMoveTargets } from './workspaceMoveTargets';
