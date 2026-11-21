---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# O SPA carrega as 26 telas num arquivo só (1,79 MB, 518 KB gzip) antes do login

- **Severidade:** média
- **Confiança:** confirmado (medido no `dist` de 2026-11-07)
- **Categoria:** desempenho
- **Subcategoria:** divisão de código por rota
- **Arquivos afetados:** `apps/web/src/App.tsx:13-38`, `apps/web/vite.config.ts:14-24`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P/M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Para mostrar a tela de login, o navegador baixa e interpreta o código de todas as telas do sistema, inclusive o canvas, a administração de IA e os contratos. Em celular ou rede lenta, a primeira abertura demora mais do que precisa.

### Evidência e análise técnica
- `App.tsx:13-38` importa as 26 páginas de forma estática (`import { CaixaPage } from './pages/CaixaPage'` …). Não há `React.lazy` nem `Suspense` em `apps/web/src` (o único `lazy` é o atributo `loading="lazy"` de `<img>`).
- Com isso entram no arquivo principal o React Flow (`components/canvas/*`, só usado em `/flow` e na gaveta), o `marked` + `DOMPurify` (só no chat, nas notas e nos documentos de contrato) e todo o console de IA.
- Build de 2026-11-07 (`apps/web/dist/assets`): `index-*.js` com **1.787.756 bytes (518 KB gzip)**. Os únicos pedaços separados são os que já usam `import()` dinâmico: jsPDF/html2canvas (`lib/export.ts:39`) e o pdf.js (`components/contracts/PdfViewer.tsx:20`).
- `vite.config.ts:16` sobe o `chunkSizeWarningLimit` para 800 KB, e o arquivo de 1,79 MB passa assim mesmo; o aviso que denunciaria o problema está calado na prática.

### Verificação (tentativa de refutação)
- O servidor serve os arquivos com hash e cache longo? Isso ajuda a segunda visita, não a primeira nem a primeira depois de cada release (o hash muda a cada build).
- As telas são de uso interno, com poucos usuários. O custo é real mesmo assim no celular, onde o console também é usado (o alarme dos lembretes e o chat), e cada release invalida o arquivo inteiro.

### Impacto
Primeira carga e cada atualização de versão baixam e compilam ~1,8 MB de JavaScript, quando a tela de login e a visão geral precisam de uma fração disso.

## Como reproduzir
```bash
pnpm --filter @moneyflow/web build
ls -la apps/web/dist/assets/*.js
```

## Solução proposta
1. Em `App.tsx`, trocar os imports das páginas por `React.lazy(() => import('./pages/X').then((m) => ({ default: m.X })))` e envolver as `<Routes>` num `<Suspense>` com o carregando do template (o mesmo do `ui.tsx`).
2. Manter estáticas só a `LoginPage`, a `OverviewPage` e a casca (`Layout`, `AgentsProvider`); o canvas, a administração de IA, contratos, receitas e backup ficam em pedaços próprios.
3. Carregar o `Markdown.tsx` (marked + DOMPurify) sob demanda dentro das janelas do agente e dos documentos.
4. Voltar o `chunkSizeWarningLimit` para o padrão (500 KB) para o aviso voltar a valer.
5. Conferir que a CSP do SPA (`security-headers.ts`, spec 001) continua aceitando os pedaços (são do mesmo `'self'`).

## Critérios de aceite
- [ ] O arquivo principal fica abaixo de 500 KB sem gzip.
- [ ] Abrir `/login` não baixa o código do canvas nem do console de IA (aba Rede do navegador).
- [ ] O build não emite aviso de tamanho com o limite padrão.
- [ ] Os e2e passam (as telas carregam sob demanda).

## Testes recomendados
`pnpm e2e` inteiro (navegação por todas as telas) e o atalho "Ir para" da paleta de comandos, que troca de rota sem recarregar.

## Limitações e suposições
O tamanho foi medido no `dist` existente (build de 2026-11-07, antes da v0.1.22); a ordem de grandeza não muda. Não medi o tempo de carga real.

## Análise (triagem)

## Resolução (executor)
