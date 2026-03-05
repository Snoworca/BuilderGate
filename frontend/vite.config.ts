/**
 * Vite Configuration
 * Phase 7: Frontend Security - HTTPS proxy for self-signed certificates
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4545,
    hmr: {
      port: 4545,
    },
    proxy: {
      '/api': {
        target: 'https://localhost:4242',
        changeOrigin: true,
        secure: false,  // Accept self-signed certificates
      },
    },
  },
});
