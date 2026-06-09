/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/health': 'http://localhost:8000',
      '/features': 'http://localhost:8000',
      '/repositories': 'http://localhost:8000',
      '/summaries': {
        target: 'http://localhost:8000',
        bypass(req) {
          // Navigation requests (browser page loads) must get the SPA, not backend JSON
          if (req.headers.accept?.includes('text/html')) return '/index.html';
          return null;
        },
      },
      '/commit-snapshots': 'http://localhost:8000',
      '/youtrack': 'http://localhost:8000',
      '/logs': 'http://localhost:8000',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
  },
})
