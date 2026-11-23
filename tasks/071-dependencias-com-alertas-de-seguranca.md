---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-11-21
commit:
---

# Dependências com alertas de segurança (`pnpm audit`: 7 altos) e sem checagem no CI

- **Severidade:** alta
- **Confiança:** confirmado (o alerta existe); provável (o quanto cada um é explorável aqui)
- **Categoria:** segurança
- **Subcategoria:** dependências desatualizadas
- **Arquivos afetados:** `apps/server/package.json:25-29`, `apps/web/package.json:16-21`, `packages/shared/package.json:15`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M (o `pdfjs-dist` é troca de versão maior)
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Algumas bibliotecas que o sistema usa têm falhas de segurança já publicadas e corrigidas em versões mais novas. As versões estão travadas no projeto desde outubro e nada avisa quando sai uma correção.

### Evidência e análise técnica
`pnpm audit` em 2026-11-21: **38 alertas (7 altos, 22 moderados, 9 baixos)**. As versões são fixas (sem `^`) e o `pnpm-lock.yaml` não muda desde 2026-10-14 (`git log -- pnpm-lock.yaml`). O CI não roda `pnpm audit` e não há Dependabot/Renovate (`.github/` só tem `workflows/`).

Dependências diretas afetadas:

| Pacote | Versão | Corrigido em | Severidade | Alerta | Onde é usado |
|---|---|---|---|---|---|
| `pdfjs-dist` | 5.7.284 | ≥ 6.2.108 | alta | Execução de JavaScript arbitrário ao abrir um PDF malicioso (GHSA-hq66-cqwq-w95j) | `apps/web/src/components/contracts/PdfViewer.tsx:20-23` (PDF de contrato enviado por um usuário, aberto por outros) e `apps/server/src/agents/pdf-text.ts:44,84` (PDF anexado no chat e lido no servidor) |
| `zod` | 4.6.5 | ≥ 4.6.6 | alta | Esgota memória ao validar coleções grandes com restrição (GHSA-mrhx-c7xc-m3w5) | toda entrada da API e das tools |
| `fflate` | 0.8.2 | ≥ 0.8.3 | moderada | `unzipSync` em laço infinito com ZIP64 malformado (GHSA-px8p-9vwx-vf98) | `services/backup/{export,import,dump}.ts` |
| `fastify` | 5.12.5 | ≥ 5.12.6 | baixa | Validação de cabeçalho contornável (GHSA-389g-gv7q-r4x8) | servidor |
| `dompurify` | 3.4.16 | ≥ 3.4.17 | baixa | três alertas de modos que o projeto não usa | `apps/web/src/agents/Markdown.tsx:57` |

Transitivas, que somem ao atualizar o pacote pai:

| Pacote | Vem de | Severidade |
|---|---|---|
| `undici` 8.11.2 (4 altos, 4 moderados; um deles é bypass da validação de certificado TLS, GHSA-2m5v-pch6-74hx) | `openai` 7.32.0 (o mais novo é 7.62.0) | alta |
| `body-parser`, `hono`, `@hono/node-server`, `qs`, `fast-uri` | `@modelcontextprotocol/sdk` 1.32.1 (1.32.2) | alta/moderada |
| `fast-uri` 4.x | `fastify` 5.12.5 | moderada |
| `ip-address` | `@fastify/rate-limit` 11.2.1 (11.3.0) | moderada |
| `esbuild`, `glob`, `minimatch` | `drizzle-kit`, `testcontainers` (só desenvolvimento) | moderada |

### Verificação (tentativa de refutação)
- `fflate`: o projeto NÃO chama `unzipSync`. `services/backup/unzip.ts` tem leitor próprio (o comentário da linha 11 diz isso) e os outros arquivos só importam `Zip`, `ZipDeflate`, `ZipPassThrough`, `strToU8` e `strFromU8`. O alerta não é alcançável hoje; a atualização é de higiene.
- `dompurify`: o `Markdown.tsx` usa `sanitize` com `USE_PROFILES: { html: true }`, sem `IN_PLACE`, `SAFE_FOR_TEMPLATES` nem XHTML. Os três alertas não se aplicam.
- `body-parser`/`hono`: `routes/mcp.ts` usa `Server` e `StreamableHTTPServerTransport` do SDK sobre o Fastify, sem o Express nem o Hono do SDK. Provavelmente não alcançável; não confirmei se o transporte importa o `@hono/node-server` por dentro.
- `pdfjs-dist`: o visualizador abre o PDF com `getDocument({ url, withCredentials: true })`, sem `isEvalSupported: false`. Não li o texto do alerta (revisão sem rede além do `pnpm audit`), então não sei se alguma opção mitiga. Fica como alto até prova em contrário, porque o PDF vem de outro usuário.
- `undici`: o SDK da OpenAI traz o `undici` como dependência; não confirmei se a chamada passa por ele ou pelo `fetch` global do Node (o projeto injeta o próprio `fetch` em `agents/llm/request-log.ts`).

### Impacto
O pior caso é o do `pdfjs-dist`: um editor de uma caixa envia um PDF de contrato preparado e o script roda no navegador de quem abrir o documento, com a sessão dele (inclusive a de um admin). O do `zod` permite derrubar a API com um corpo JSON montado para isso, dentro do limite de corpo.

## Como reproduzir
```bash
pnpm audit
pnpm outdated -r
```

## Solução proposta
1. Atualizações de correção, sem mudança de API: `zod` 4.6.7, `fastify` 5.12.8, `dompurify` 3.4.18, `fflate` 0.8.3, `@modelcontextprotocol/sdk` 1.32.2, `@fastify/rate-limit` 11.3.0, `@fastify/static` 10.1.12, `@fastify/cookie` 11.1.5, `openai` 7.62.0.
2. `pdfjs-dist` 6.x no servidor e no web: versão maior. Ler as notas de migração, ajustar `pdf-text.ts` (build `legacy`, worker na thread principal) e o `PdfViewer.tsx`, e passar `isEvalSupported: false` nos dois `getDocument`. Rodar `test/capabilities.test.ts`, `test/chat-media.test.ts` e o e2e de contratos.
3. Se alguma transitiva continuar vulnerável depois do passo 1, fixar com `pnpm.overrides` na raiz.
4. Pôr `pnpm audit --prod --audit-level high` no `ci.yml` (falha em alto ou crítico de produção) e ligar o Dependabot ou o Renovate para `npm` e `github-actions`, com as correções de segurança agrupadas.

## Critérios de aceite
- [ ] `pnpm audit --prod --audit-level high` termina sem alertas.
- [ ] O CI falha quando aparece um alerta alto em dependência de produção.
- [ ] Os PDFs de contrato e do chat continuam abrindo e sendo lidos (testes existentes passam).

## Testes recomendados
`pnpm verify:full --e2e` depois das atualizações. Não há teste novo a escrever, fora o passo do CI.

## Limitações e suposições
Só o `pnpm audit` e o `pnpm outdated` foram executados. O texto de cada alerta não foi lido, então a explorabilidade do `pdfjs-dist`, do `zod` e do `undici` neste projeto está marcada como provável, não confirmada. A lista de alertas muda com o tempo: rode de novo ao pegar a tarefa.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

`pnpm audit` em 2026-11-22 confirmou os 38 alertas (7 altos). Os altos eram quatro pacotes:
- `pdfjs-dist` 5.7.284 (GHSA-hq66-cqwq-w95j, corrigido só na 6.2.108: não há 5.x corrigida);
- `zod` 4.6.5;
- `body-parser` 2.3.0, do `express` do `@modelcontextprotocol/sdk`;
- `undici` 8.11.2 (quatro altos). Ele vem do `testcontainers` (dependência de desenvolvimento); no `openai` é só um peer opcional, resolvido para o mesmo `undici` da árvore.

O alerta do pdf.js só vale com `enableScripting` ligado, opção do visualizador completo (`pdf_viewer`), que o projeto não usa: o `PdfViewer.tsx` só desenha a página no canvas. A CSP do SPA (tarefa 065) também barra o script. Mesmo assim, a troca de versão é o que zera o alerta.

## Resolução (executor)

Atualizado só o necessário para zerar os altos, por versão de correção, fora o `pdfjs-dist`:
- `zod` 4.6.5 → 4.6.7 (`packages/shared`, `apps/server`).
- `testcontainers` e `@testcontainers/postgresql` 12.2.0 → 12.2.2: trazem o `undici` 8.13.1, que o peer do `openai` também usa. O `openai` ficou na 7.32.0.
- `body-parser` 2.3.0 → 2.4.0 (e o `qs` 6.17.1 dele), só no lockfile, dentro da faixa do `express`. Foi feito com um `pnpm.overrides` temporário, tirado em seguida: o `pnpm update body-parser` também mexia no `rolldown` e no `postcss` do vitest sem precisar.
- `pdfjs-dist` 5.7.284 → 6.4.299 no servidor e no web. É troca de versão maior, inevitável: a 6.4 é a mais nova sem mudança de arquitetura. A 6.5 passa o desenho do canvas para um worker.
  - Notas da 6.0 a 6.4 lidas. Afetam o projeto só a remoção do `PDFDocumentProxy.destroy()` (6.0) e o mínimo de Node `>=22.13`.
  - `PdfViewer.tsx`: o `loadPdf` devolve o documento com `destroy` ligado ao `loadingTask.destroy()`. O fechamento do visualizador e da miniatura do chat (`AttachmentPreview.tsx`) chamava um método que não existe mais.
  - `pdf-text.ts` sem mudança: a build `legacy` e o worker na própria thread continuam iguais.
  - O `isEvalSupported` sugerido não existe mais no pdf.js 6, que não usa `eval`.
  - Conferido também o bundle no formato do `build.mjs`, rodando fora de qualquer `node_modules`, como na imagem: extrai o texto e conta as páginas. O `vite build` do web gera o worker 6.4.
- CI: passo "Alertas de segurança das dependências" (`pnpm audit --prod --audit-level high`) no job `check`, logo depois do `pnpm install`.
- `.github/dependabot.yml`:
  - npm só com as correções de segurança, num grupo; as atualizações de versão ficam desligadas, porque as versões são fixas;
  - `github-actions` e a base `docker` do `Dockerfile` toda semana.
  - Falta ligar "Dependabot security updates" nas configurações do repositório.
- Ficam os moderados e baixos, sem alto nem crítico. São `fflate`, `fastify`, `dompurify`, `fast-uri`, `ip-address`, `hono`, `@hono/node-server`, `esbuild` do `drizzle-kit`, e `glob`/`minimatch`. A tarefa pediu só o necessário para os altos.
- Resultado:
  - `pnpm audit --audit-level high`: 0 altos e 0 críticos (18 moderados, 9 baixos);
  - `pnpm audit --prod --audit-level high`: 0 altos (15 moderados, 9 baixos).

Testes: `test/capabilities.test.ts` e `test/chat-media.test.ts`, onde ficam a camada de texto e a contagem de páginas do PDF, passaram no Postgres local. Também passaram o typecheck de todos os pacotes e o `vite build`. O e2e dos contratos e da prévia de PDF no chat fica para a verificação completa da sessão principal. Verificação: `pnpm verify:quick -- test/capabilities.test.ts test/chat-media.test.ts`.
