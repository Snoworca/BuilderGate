import { useState, useEffect, useCallback } from 'react';
import { MOBILE_LAYOUT_QUERY } from '../utils/layoutMode.ts';

interface UseResponsiveReturn {
  isMobile: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
}

export function useResponsive(): UseResponsiveReturn {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches
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

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return { isMobile, sidebarOpen, toggleSidebar, closeSidebar };
}
