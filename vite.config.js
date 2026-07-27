import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020',
    // The dataset in public/ is copied verbatim; nothing else is fetched at runtime.
    assetsInlineLimit: 4096,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
