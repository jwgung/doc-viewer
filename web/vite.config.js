import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { collectLicenses, emitLicenses } from './scripts/third-party-licenses.js';

// 앱 assets/viewer/ 아래에 그대로 들어가므로 상대 경로(base: './')로 빌드한다.
export default defineConfig({
  base: './',
  plugins: [emitLicenses()],
  worker: { format: 'es', plugins: () => [collectLicenses()] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      input: { viewer: resolve(import.meta.dirname, 'viewer.html') },
    },
  },
});
