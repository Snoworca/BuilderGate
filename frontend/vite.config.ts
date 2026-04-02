/**
 * Vite Configuration
 * Phase 7: Frontend Security - HTTPS proxy for self-signed certificates
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-dnd', 'react-dnd-html5-backend'],
    alias: {
      // react-mosaic-component bundles its own react-dom@18 which conflicts with React 19.
      // Force all react/react-dom imports to resolve to the project's single copy.
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
  },
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
