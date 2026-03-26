interface Props {
  onAddTab: () => void;
}

export function EmptyState({ onAddTab }: Props) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: '16px',
      color: '#888',
    }}>
      <span style={{ fontSize: '48px' }}>⌨</span>
      <span style={{ fontSize: '16px' }}>터미널을 추가하세요</span>
      <button
        onClick={onAddTab}
        style={{
          backgroundColor: '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          padding: '8px 20px',
          cursor: 'pointer',
          fontSize: '14px',
        }}
      >
        + Add Terminal
      </button>
    </div>
  );
}
