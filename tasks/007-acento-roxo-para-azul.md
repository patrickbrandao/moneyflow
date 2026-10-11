---
status: concluida
tipo: melhoria
origem: usuario
autor: usuario
responsavel: app
prioridade: media
criada: 2026-10-11
commit:
---

# Trocar as cores de tom roxo para tom azul em todo o frontend

## Descrição
O dono do produto pediu que o acento roxo do console (cor de ação, seleção, foco, logo) e qualquer outro tom roxo do frontend passem a ser azuis, nos dois temas.

## Como reproduzir
Abrir http://localhost:3000 em qualquer tela: botões primários, links ativos, foco, seleção, logo e a paleta de categorias/canvas usam roxo.

## Análise (triagem)
Pedido direto do usuário, sem ambiguidade de causa; designado pela sessão principal ao `app`. Pontos de atenção: o acento vive em `apps/web/src/styles/tokens.css` (bloco "acento" + `--ring-accent`/`--accent-tint` com rgba roxo), há roxo também na paleta `--port-N` (o `--port-1`), possivelmente no `public/logo.svg`, no `index.html` (theme-color) e em textos de spec/AGENTS.md que dizem "acento roxo".

## Resolução (executor)
O acento passou a azul nos dois temas e nenhuma cor do console fica mais na faixa roxa (matiz 250°–320°).

- `apps/web/src/styles/tokens.css`:
  - Acento escuro: `--accent` #5712a5 → #1d5bbf, `--accent-hover` #8b47d9 → #2f6fd6, `--accent-soft` #935cd2 → #4a88d8, `--accent-deep` #5a22a0 → #1a4a94, `--accent-tint` rgba(121,52,199,.16) → rgba(47,111,214,.16) e `--ring-accent` → rgba(47,111,214,.35).
  - Acento claro: #460194 → #0b4fb3, hover #380880 → #093f90, soft #5b1ca0 → #1557b8, deep #1b0959 → #0a2a63, tint → rgba(29,90,190,.1) e ring → rgba(29,90,190,.25).
  - Branco sobre o acento: 6,4:1 no escuro e 7,5:1 no claro; no hover, 4,8:1 e 9,9:1 (AA).
  - `--info` ficava quase igual ao novo acento e virou azul-petróleo: #5d74aa → #4a9aa8 no escuro e #4a63a0 → #256f80 no claro, com os tints correspondentes.
  - `--port-N`: o 1 virou o azul do acento (#4a88d8 / #1a5cc0). O 2 deixou de ser azul-celeste e virou um azul mais claro e menos saturado (#92a3e8 / #5e74c9). O 7 trocou o magenta-arroxeado por rosa (#d86a9c / #b0407a). O 10 trocou o anil por amarelo (#d6c45a / #9e9010). O 12 virou cinza frio (#8a8f99 / #62666f). As outras cores não mudaram.
  - Os neutros (chassi, fundos, fios, textos, overlay) perderam o leve tom violeta e passaram para um azul-frio de mesma luminância (matiz ~225°).
- `apps/web/public/logo.svg`: o gradiente #b48ae6 → #5712a5 virou #6fa3ea → #0b4fb3.
- `apps/web/src/lib/export.ts`: os cinzas do PDF passaram a frios.
- `apps/web/src/components/ui.tsx`: `monogramColor` pula a faixa roxa.
- `apps/web/src/styles/shell.css`: comentário que citava o roxo.
- Teste: `e2e/tests/tema.spec.ts`. Nos dois temas, confere o acento azul, nada roxo no acento, no anel, nos neutros, no `--info`, nas 12 `--port-N` e no logo, AA do branco sobre o acento e o hover, `--info` distante do acento e as 12 `--port-N` distintas duas a duas (OKLab > 0,06). Passa no dev e no build; falha na imagem antiga.
- No navegador, nos dois temas: login, visão geral, caixas e detalhe da caixa, entidades, transferências, calendário, fluxo (canvas), relatórios, mensagens, categorias, usuários, auditoria, IA e agentes, minha conta e o menu de conversas dos agentes. Uma varredura das cores computadas de todos os elementos não achou nenhuma na faixa roxa.
- Specs: `AGENTS.md` e `docs/001-stack-e-entrega.md` (acento azul, sem faixa roxa).
