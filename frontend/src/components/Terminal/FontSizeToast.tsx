import { useEffect, useState } from 'react';
import './FontSizeToast.css';

interface Props {
  fontSize: number | null;
  duration?: number;
}

export function FontSizeToast({ fontSize, duration = 1000 }: Props) {
  const [visible, setVisible] = useState(false);
  const [prevFontSize, setPrevFontSize] = useState(fontSize);

  // React-approved pattern: adjust state during render when props change
  // See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (fontSize !== prevFontSize) {
    setPrevFontSize(fontSize);
    if (fontSize !== null) {
      setVisible(true);
    }
  }

  useEffect(() => {
    if (fontSize !== null && visible) {
      const timer = setTimeout(() => setVisible(false), duration);
      return () => clearTimeout(timer);
    }
  }, [fontSize, duration, visible]);

  if (!visible || fontSize === null) return null;

  return (
    <div className="font-size-toast">
      {fontSize}px
    </div>
  );
}
