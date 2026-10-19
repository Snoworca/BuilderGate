import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';
import { initI18n } from './i18n/i18n';
import { installVisualViewportHeightSync } from './utils/visualViewportHeightSync';
import './index.css';

// FR-ARCH-011: keep the header and tab bar on screen while the iOS keyboard is open.
installVisualViewportHeightSync(window, document.documentElement);

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
