// Web UI build. viteSingleFile inlines the JS, CSS and the Inter font into one index.html, because the standalone
// executable embeds the page as a single string (see scripts/build-standalone.mjs). No CDN, works offline.
// `npm run dev:ui` serves it with hot reload and proxies /api to the running launcher (UI_PORT, default 8791).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { outDir: '../build-ui', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': { target: `http://127.0.0.1:${process.env.UI_PORT || 8791}`, changeOrigin: true } } },
});
