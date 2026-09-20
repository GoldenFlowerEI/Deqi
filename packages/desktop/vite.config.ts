import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the deqi desktop frontend.
//
// Tauri serves the dev bundle from a custom protocol (tauri://)
// in production, so we set base to './' for relative asset paths.
// The dev server runs on 5173 by default; Tauri proxies to it
// from the Rust shell via the devUrl in tauri.conf.json.
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
