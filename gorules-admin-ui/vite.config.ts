import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Admin UI runs on :5173 and proxies /api to the headless GoRules TS engine on :3001.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow importing the shared canonical test cases from the repo root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
