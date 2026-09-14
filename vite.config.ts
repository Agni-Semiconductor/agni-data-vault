/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // '' as the prefix reads EVERY variable, not just VITE_-prefixed ones. That matters here: these
  // two must NOT be VITE_-prefixed, because vite inlines anything with that prefix into the browser
  // bundle, and DEV_API_KEY is a credential. They are read here in the config, which runs in node,
  // and are never referenced from src/ -- so `tests/noClientSecrets.test.ts` stays satisfied.
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.DEV_API_TARGET

  return {
    plugins: [react(), tailwindcss()],
    worker: {
      format: 'es',
    },
    // A LOCAL-ONLY affordance, inert unless DEV_API_TARGET is set (put it in .env.local, which is
    // gitignored). In production the SPA and the API are same-origin behind Cloudflare, and the
    // browser authenticates with an Access session cookie. Neither exists on a laptop, and the API
    // refuses an unauthenticated request by design -- so without this, every data call in dev comes
    // back as the SPA's own index.html and the first JSON.parse fails with
    // `Unexpected token '<'`, which reads as a broken app rather than a missing backend.
    //
    // The key is attached by the dev server, not by the page, so it never reaches the bundle.
    server: target
      ? {
          proxy: {
            '/api': {
              target,
              changeOrigin: true,
              headers: env.DEV_API_KEY ? { Authorization: `Bearer ${env.DEV_API_KEY}` } : undefined,
            },
          },
        }
      : undefined,
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    },
  }
})
