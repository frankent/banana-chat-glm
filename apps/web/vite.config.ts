import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev topology (D1): Vite on :5173, API on host :8000, Reverb on :8088.
// Changes on every build so the push service worker gets a new URL, and with it a
// new cache key and a fresh install on devices holding an older copy.
const buildId = Date.now().toString(36);

export default defineConfig({
  define: {__SW_BUILD_ID__: JSON.stringify(buildId)},
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/broadcasting': 'http://127.0.0.1:8000',
    },
  },
});
