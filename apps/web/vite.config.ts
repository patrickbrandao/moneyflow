import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** A raiz do monorepo: o `.env` dela é o mesmo que o `pnpm dev` da API lê (tarefa 185). */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Teto do arquivo de entrada (tarefa 128): as telas, o miolo da conversa dos
 * agentes e a paleta são pedaços sob demanda (`lazyNamed`), e o arquivo
 * principal leva só a casca, o login e a visão geral. Passar do teto falha o
 * build, em vez de só avisar. Os 500 KB do padrão do Vite não cabem: o React
 * DOM (~210 KB) e o dicionário `t` do shared (~160 KB, um objeto só) já somam
 * quase isso; o arquivo principal ficou em 556 KiB (era 1,8 MB). O `sideEffects`
 * do `packages/shared/package.json` deixa o Rollup largar os módulos do shared
 * que a casca não usa (as entradas Zod, o registro das tools).
 */
const ENTRY_BUDGET_KB = 640;

function entryBudget(): Plugin {
  return {
    name: 'moneyflow:entry-budget',
    apply: 'build',
    enforce: 'post',
    // No writeBundle o código já é o final (minificado e com a lista de pré-carga).
    writeBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !file.isEntry) continue;
        const kb = Math.round(Buffer.byteLength(file.code) / 1024);
        if (kb > ENTRY_BUDGET_KB) {
          this.error(
            `${file.fileName} tem ${kb} KB, acima do teto de ${ENTRY_BUDGET_KB} KB: carregue a tela ou o componente novo pelo lazyNamed (lib/lazy.ts).`,
          );
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  /*
   * Em dev, o Vite encaminha `/api` e o servidor MCP (`/mcp`) para a API, na porta que ela escuta: o PORT do
   * `.env` da raiz (padrão 3001), ou API_PORT para apontar para outra; WEB_PORT troca a do Vite (5174). O que
   * já está no ambiente vence o arquivo, como na API. Só a configuração lê estas variáveis: nada do `.env` da
   * raiz chega ao código do console (o `import.meta.env` continua só com o envDir e o prefixo VITE_).
   */
  const env = loadEnv(mode, ROOT, '');
  const api = `http://localhost:${env.API_PORT || env.PORT || '3001'}`;
  return {
    plugins: [react(), tailwindcss(), entryBudget()],
    server: {
      port: Number(env.WEB_PORT || 5174),
      proxy: { '/api': api, '/mcp': api },
    },
    build: {
      outDir: 'dist',
      // O aviso do Vite vale para todo pedaço, com o mesmo teto do arquivo principal.
      chunkSizeWarningLimit: ENTRY_BUDGET_KB,
      rollupOptions: {
        // O zod traz comentários /*@__PURE__*/ em posições que o Rollup ignora: aviso inofensivo.
        onwarn(warning, warn) {
          if (warning.code === 'INVALID_ANNOTATION') return;
          warn(warning);
        },
      },
    },
  };
});
