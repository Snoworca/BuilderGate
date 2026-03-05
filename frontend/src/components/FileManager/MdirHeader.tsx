import './MdirPanel.css';

interface Props {
  currentPath: string;
  isActive?: boolean;
}

export function MdirHeader({ currentPath, isActive }: Props) {
  return (
    <div className={`mdir-header${isActive === false ? ' mdir-header-inactive' : ''}`}>
      <span className="mdir-path" title={currentPath}>
        {currentPath}
      </span>
    </div>
  );
}
