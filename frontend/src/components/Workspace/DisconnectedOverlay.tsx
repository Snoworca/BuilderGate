interface Props {
  onRestart: () => void;
}

export function DisconnectedOverlay({ onRestart }: Props) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.7)',
      zIndex: 10,
      gap: '12px',
    }}>
      <span style={{ fontSize: '20px', color: '#f43f5e' }}>⚠</span>
      <span style={{ fontSize: '14px', color: '#ccc' }}>세션이 종료되었습니다</span>
      <button
        onClick={onRestart}
        style={{
          backgroundColor: '#22c55e',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          padding: '6px 16px',
          cursor: 'pointer',
          fontSize: '13px',
        }}
      >
        재시작
      </button>
    </div>
  );
}
