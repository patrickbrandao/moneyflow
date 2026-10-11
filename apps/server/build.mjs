import { build } from 'esbuild';

/*
 * Empacota a API/worker num único arquivo (dist/main.mjs) com todas as
 * dependências, inclusive os pacotes do workspace (TypeScript), para a imagem
 * Docker rodar sem node_modules.
 */
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  // pg-native é opcional no pg e não é usado.
  external: ['pg-native'],
  // Dependências CommonJS usam require() dentro do bundle ESM.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
