/**
 * Vite Configuration
 * Phase 7: Frontend Security - HTTPS proxy for self-signed certificates
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const serverPort = parseInt(process.env.DEV_SERVER_PORT || '2002', 10);
const frontendPort = parseInt(process.env.DEV_FRONTEND_PORT || '2003', 10);

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
    port: frontendPort,
    hmr: {
      path: '/__vite_hmr',
      port: frontendPort,
      clientPort: serverPort,
      protocol: 'wss',
    },
    proxy: {
      '/api': { target: `https://localhost:${serverPort}`, secure: false, changeOrigin: true },
      '/health': { target: `https://localhost:${serverPort}`, secure: false, changeOrigin: true },
      '/ws': { target: `wss://localhost:${serverPort}`, secure: false, ws: true, changeOrigin: true },
    },
  },
});
