import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev topology (D1): Vite on :5173, API on host :8000, Reverb on :8088.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/broadcasting': 'http://127.0.0.1:8000',
    },
  },
});
