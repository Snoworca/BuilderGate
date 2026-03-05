import { useState, useCallback } from 'react';

interface ContextMenuState {
  isOpen: boolean;
  position: { x: number; y: number };
  targetId: string | null;
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({
    isOpen: false,
    position: { x: 0, y: 0 },
    targetId: null,
  });

  const open = useCallback((x: number, y: number, targetId: string) => {
    setState({ isOpen: true, position: { x, y }, targetId });
  }, []);

  const close = useCallback(() => {
    setState({ isOpen: false, position: { x: 0, y: 0 }, targetId: null });
  }, []);

  return { ...state, open, close };
}
