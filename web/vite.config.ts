import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything (JS + CSS) is inlined into one index.html so it can be opened as a plain file,
// served by the backend, or bundled into the Android app.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 100_000_000 },
});
