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
      path: '/__vite_hmr',
      port: 4545,
      clientPort: 4242,
      protocol: 'wss',
    },
  },
});
