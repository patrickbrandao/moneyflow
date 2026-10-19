import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Em dev, o Vite encaminha `/api` e o servidor MCP (`/mcp`) para a API (PORT do .env, padrão 3001).
const api = `http://localhost:${process.env.API_PORT ?? '3001'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5174),
    proxy: { '/api': api, '/mcp': api },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      // O zod traz comentários /*@__PURE__*/ em posições que o Rollup ignora: aviso inofensivo.
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION') return;
        warn(warning);
      },
    },
  },
});
