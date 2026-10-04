import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = {
  '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@': fileURLToPath(new URL('./src/ui', import.meta.url)),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: fileURLToPath(new URL('./electron/main/index.ts', import.meta.url)) } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: fileURLToPath(new URL('./electron/preload/index.ts', import.meta.url)) } },
    },
  },
  renderer: {
    root: 'src/ui',
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: { input: fileURLToPath(new URL('./src/ui/index.html', import.meta.url)) },
    },
  },
});
