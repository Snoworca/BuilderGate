import { useState, useEffect, useCallback } from 'react';

const MOBILE_BREAKPOINT = 768;

interface UseResponsiveReturn {
  isMobile: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
}

export function useResponsive(): UseResponsiveReturn {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => window.innerWidth < MOBILE_BREAKPOINT
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

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
