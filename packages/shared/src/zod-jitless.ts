import { z } from 'zod';

/*
 * Desliga o JIT do Zod, que testa `new Function("")` ao criar os schemas. O console roda sob uma CSP
 * sem `unsafe-eval` (tarefa 065): sem isto o Zod cairia no fallback de qualquer jeito, mas deixaria
 * uma violação de CSP no console a cada carga. Importado como PRIMEIRO import do `main.tsx` do console,
 * antes de qualquer schema do shared; a API não o importa (lá não há CSP).
 */
z.config({ jitless: true });
