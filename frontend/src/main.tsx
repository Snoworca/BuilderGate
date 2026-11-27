import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';
import { initI18n } from './i18n/i18n';
import { startAppTheme } from './theme/appTheme';
import { installVisualViewportHeightSync } from './utils/visualViewportHeightSync';
import { installStandaloneViewport } from './utils/standaloneViewport';
import './index.css';

// FR-ARCH-016 AC-6: opened from the iPhone home screen, cover the screen and pad the safe area.
installStandaloneViewport(window, document);

// FR-ARCH-011: keep the header and tab bar on screen while the iOS keyboard is open.
installVisualViewportHeightSync(window, document.documentElement);

// FR-UIDS-020: take over the theme public/theme-boot.js applied, and follow the OS for 'system'.
// @req FR-UIDS-020 AC-4
startAppTheme();

// FR-I18N-002: the catalog is installed before the first render.
void initI18n(navigator.language).then((lang) => {
  document.documentElement.lang = lang;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  );
});
