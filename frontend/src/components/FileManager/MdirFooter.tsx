import './MdirPanel.css';

interface FunctionKeyDef {
  key: string;
  label: string;
  onClick: () => void;
  active?: boolean;
}

interface Props {
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  functionKeys: FunctionKeyDef[];
}

export function MdirFooter({ fileCount, dirCount, totalBytes, functionKeys }: Props) {
  return (
    <div className="mdir-footer">
      <div className="mdir-status-bar">
        {fileCount} File&nbsp;&nbsp;{dirCount} Dir&nbsp;&nbsp;{totalBytes.toLocaleString()} Byte
      </div>
      <div className="mdir-function-bar">
        {functionKeys.map(fk => (
          <button
            key={fk.key}
            className={`mdir-fkey${fk.active ? ' mdir-fkey-active' : ''}`}
            onClick={fk.onClick}
          >
            <span className="mdir-fkey-num">{fk.key}</span>
            <span className="mdir-fkey-label">{fk.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
