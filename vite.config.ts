import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, secure: false }, '/live': { target: 'ws://localhost:3000', ws: true, changeOrigin: true, secure: false } } },
  build: {
    outDir: 'dist',
    emptyOutDir: false, // server.cjs lives alongside renderer output
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          character: ['mmd-parser'],
        },
      },
    },
  },
});
