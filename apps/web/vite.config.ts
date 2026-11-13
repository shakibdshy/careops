import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import { env } from 'node:process';

import { tanstackStart } from '@tanstack/react-start/plugin/vite';

import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Bundle server-side dependencies into dist/server so the production image
  // ships no node_modules at all — the SSR handler is the only runtime code
  // (W3-T4 web container: slim Node + dist + server.mjs).
  ssr: { noExternal: true },
  server: {
    proxy: {
      '/api': {
        // Defaults to the boot API; override to point an isolated web instance
        // at a receipts/measurement API without touching the dev stack (W2-T9).
        target: env.API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

export default config;
