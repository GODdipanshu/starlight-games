import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat']
  },
  build: {
    target: 'esnext'
  }
});
