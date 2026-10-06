import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Vite config.
 *
 * Two things are load-bearing here:
 *
 * 1. In production the built bundle is served by the Fastify API from the same
 *    origin (`server/src/index.ts` mounts `client/dist`), so the app uses
 *    relative URLs everywhere and there is no CORS surface at all.
 *
 * 2. In dev, the same relative URLs are proxied to the API. This matters beyond
 *    convenience: inside a sandboxed preview the browser cannot reach
 *    `localhost:8787` directly, so hardcoding an API origin would break the
 *    preview. Proxying keeps `fetch('/auth/login')` correct in both modes.
 *
 * `host: 0.0.0.0` and an empty `allowedHosts` restriction let the dev server be
 * reached through a proxy hostname rather than only via localhost.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // The domain contract is shared with the server so the two can never drift.
      '@shared': resolve(__dirname, '../shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/realtime': {
        target: process.env.MURMUR_API ?? 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: false,
      },
      '^/(auth|users|settings|contacts|conversations|messages|media|calls|admin|reports|developer|controller|health|me)(/|$)': {
        target: process.env.MURMUR_API ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    // A single chunk keeps the first paint fast on mobile networks; code
    // splitting can be reintroduced once the bundle grows past ~300 kB.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
