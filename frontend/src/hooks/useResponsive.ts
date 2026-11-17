import { useState, useEffect, useCallback } from 'react';
import { MOBILE_LAYOUT_QUERY } from '../utils/layoutMode.ts';
import { TOUCH_INPUT_QUERY, usesTouchInput } from '../utils/touchInput.ts';

interface UseResponsiveReturn {
  /** The phone layout (FR-UIDS-015). */
  isMobile: boolean;
  /** A finger is the primary pointer: the phone layout or a tablet such as an iPad (FR-MKB-013 AC-5). */
  isTouchInput: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
}

export function useResponsive(): UseResponsiveReturn {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches
  );
  const [coarsePointer, setCoarsePointer] = useState<boolean>(
    () => window.matchMedia(TOUCH_INPUT_QUERY).matches
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_LAYOUT_QUERY);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) {
        setSidebarOpen(false);
      }
    };

    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const mql = window.matchMedia(TOUCH_INPUT_QUERY);
    const handleChange = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const isTouchInput = usesTouchInput({ mobileLayout: isMobile, coarsePointer });
  return { isMobile, isTouchInput, sidebarOpen, toggleSidebar, closeSidebar };
}
