// FR-AITUI-009 AC-1 — the header button: save (bookmark), saved, or resume.
import { Icon } from '../common/Icon.tsx';
import { Badge, Tooltip } from '../ui/index.ts';
import type { SaveButtonState } from './sessionSnapshotModel.ts';
import './SessionSave.css';

export interface SessionSaveButtonProps {
  state: SaveButtonState;
  onClick: () => void;
}

export function SessionSaveButton({ state, onClick }: SessionSaveButtonProps) {
  if (state.kind === 'pending') {
    return (
      <button
        type="button"
        className="session-save-pill session-save-pill-pending"
        aria-label={`저장된 세션 ${state.count}개 이어하기`}
        title="저장된 세션 이어하기"
        onClick={onClick}
      >
        <Icon name="resume" size={16} />
        이어하기
        <span className="session-save-pill-count">{state.count}</span>
      </button>
    );
  }
  if (state.kind === 'saved') {
    return (
      <button
        type="button"
        className="session-save-pill session-save-pill-saved"
        aria-label={`${state.label}, 누르면 지금 상태로 다시 저장`}
        title="세션을 저장했습니다. 누르면 지금 상태로 다시 저장합니다."
        onClick={onClick}
      >
        <Icon name="bookmark-check" size={16} />
        {state.label}
      </button>
    );
  }
  return (
    <Tooltip
      title="세션 저장 · 재시작 준비"
      content={state.disabled
        ? '실행 중인 AI 세션이 없습니다.'
        : `실행 중인 AI 세션 ${state.badge}개의 이어하기 ID를 저장합니다. 에이전트는 멈추지 않습니다. BuilderGate를 재시작하기 전에 누르세요.`}
    >
      <button
        type="button"
        className="icon-button icon-button-md session-save-button"
        aria-label={`세션 저장 · 재시작 준비 (AI 세션 ${state.badge}개)`}
        disabled={state.disabled}
        onClick={onClick}
      >
        <Icon name="bookmark-plus" size={18} />
        {state.badge > 0 && <Badge count={state.badge} />}
      </button>
    </Tooltip>
  );
}
