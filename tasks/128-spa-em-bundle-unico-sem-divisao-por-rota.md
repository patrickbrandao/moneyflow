---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 95d50a4
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
- [ ] O arquivo principal fica abaixo de 500 KB sem gzip. (Não: 569,77 kB, com teto de 640 KiB no build; ver a Decisão.)
- [x] Abrir `/login` não baixa o código do canvas nem do console de IA (aba Rede do navegador).
- [ ] O build não emite aviso de tamanho com o limite padrão. (Com o limite igual ao teto, 640, nenhum aviso; com o padrão, só o principal avisaria.)
- [ ] Os e2e passam (as telas carregam sob demanda). (Não rodados aqui: ficam para a verificação completa da sessão principal.)

## Testes recomendados
`pnpm e2e` inteiro (navegação por todas as telas) e o atalho "Ir para" da paleta de comandos, que troca de rota sem recarregar.

## Limitações e suposições
O tamanho foi medido no `dist` existente (build de 2026-11-07, antes da v0.1.22); a ordem de grandeza não muda. Não medi o tempo de carga real.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código e medido no build de hoje (`vite build` do `apps/web`): o `App.tsx` importava as 26 telas de forma estática, sem `lazy` nem `Suspense`, e o arquivo principal tinha 1.809,63 kB (525 kB gzip), com o `chunkSizeWarningLimit` em 800. Além das telas, entravam nele o miolo da conversa dos agentes (mensagens, composer, prévias, `marked` + DOMPurify), a paleta (cmdk + o diálogo do Radix), o registro das tools dos agentes e o Zod: o Rollup mantinha todo módulo do shared com chamada no topo (os schemas), porque o pacote não declarava `sideEffects`.

## Resolução (executor)

**Telas.** `App.tsx`: só a `LoginPage`, a `OverviewPage` e a `NotFoundPage` ficam estáticas; as outras 23 telas vêm por `lazyNamed(() => import('./pages/X'), 'X')` (`apps/web/src/lib/lazy.ts`, sobre o `React.lazy`, pelo nome do export). O `Layout` põe o conteúdo num `PageSlot` (`components/shell/PageSlot.tsx`): `Suspense` com o carregando (`.page-loading`, o `spinner` do template) só na primeira visita — a troca de rota do React Router 7 é uma transição, que mantém a tela anterior até a nova chegar — e um `ErrorBoundary` que mostra "Não foi possível abrir esta tela." com Recarregar, sem derrubar a casca (o endereço novo limpa o aviso). Quando o pedaço não carrega (versão nova no ar e os arquivos antigos sumiram), o `lazyNamed` recarrega a aba uma vez (marca em `sessionStorage`, 30 s) para buscar o `index.html` novo, que já sai com `no-cache`.

**Além das telas.** O miolo da conversa saiu do `ConversationPane.tsx` para `agents/ConversationBody.tsx` (mensagens, tools, confirmações, composer com o gravador, prévias e markdown), carregado pelo `lazyNamed` dentro da janela; a casca da janela (cabeçalho, carregando, avisos, arrastar e soltar) continua no arquivo principal. O `toolLabel` foi para `agents/tool-label.ts`, para o registro das tools não ir junto com o `format.ts`. A paleta (⌘K) é um pedaço baixado no ocioso depois da carga e montado na primeira abertura (`Layout.tsx`). No shared, `"sideEffects": ["./src/zod-jitless.ts"]` no `package.json` (o único módulo com efeito no topo; o registro das tools é montado por imports explícitos) e as entradas Zod das anotações em `notes-input.ts` (o alarme da casca usa só as constantes de `notes.ts`; o barril exporta os dois, e o bundle da API, pelo esbuild, continua com as entradas).

**Resultado** (`vite build`): arquivo principal de 1.809,63 kB / 525 kB gzip para 569,77 kB / 184 kB gzip; cada tela, o miolo da conversa (110 kB), o markdown (48 kB + DOMPurify 29 kB), a paleta (54 kB) e o canvas (206 kB) em pedaços próprios. Sem o `sideEffects` do shared, o principal ficaria em 760 KiB.

**Decisão.** O critério de 500 KB não cabe sem dividir o dicionário `t` do shared (um objeto só, ~160 KB minificado) — com o React DOM (~210 KB) e o React Router já são ~410 KB. O teto ficou em 640 KiB: o plugin `entryBudget` do `vite.config.ts` falha o build se o arquivo principal passar disso (conferido baixando o teto para 100), e o `chunkSizeWarningLimit` usa o mesmo valor, então o aviso volta a valer para todo pedaço. O `Markdown.tsx` não precisou de carga própria: entra só pelos pedaços (a conversa, as anotações, os documentos do contrato). A CSP do SPA não muda (os pedaços são do mesmo `'self'`).

Specs: 001 (linha nova "Carga do SPA") e a linha dela no `docs/INDEX.md`; 035 (as entradas em `notes-input.ts`); `AGENTS.md` (o `lib/lazy.ts` e o `notes-input.ts`).

Testes: o teto no build (`pnpm build`, também no `verify:full` e no CI). E2e novo (não rodado aqui) `e2e/tests/carga.spec.ts`: na visão geral nenhum pedaço do canvas, da administração de IA, dos contratos, da conversa ou do markdown é pedido; pelo menu a tela de contratos chega no seu pedaço; pela paleta (⌘K, "Ir para") o canvas; e nada recarrega a página. O e2e do chat (`agentes.spec.ts`) cobre o miolo da conversa sob demanda. O bundle da API foi conferido com o esbuild e `test/notes.test.ts` passou no Postgres local. Verificação: `pnpm verify:quick`.
