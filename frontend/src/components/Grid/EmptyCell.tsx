interface Props {
  onAdd: () => void;
}

export function EmptyCell({ onAdd }: Props) {
  return (
    <div
      onClick={onAdd}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1a1a1a',
        border: '1px dashed #333',
        cursor: 'pointer',
        minWidth: '120px',
        minHeight: '80px',
      }}
    >
      <span style={{ fontSize: '24px', color: '#555' }}>+</span>
    </div>
  );
}
