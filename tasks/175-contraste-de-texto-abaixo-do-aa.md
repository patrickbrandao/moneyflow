---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: bf88a24
---

# Texto secundário e valores verdes/vermelhos abaixo do AA (4,5:1), sobretudo no tema escuro padrão

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** acessibilidade (contraste)
- **Arquivos afetados:** `apps/web/src/styles/tokens.css:21,23,37-38,49,53,106,108,121`, `apps/web/src/styles/base.css:303-306,650-654`, `apps/web/src/styles/app.css:28-35`, `apps/web/src/styles/shell.css:347-348,728-730,795-796`, `e2e/tests/tema.spec.ts:118-160`
- **Depende de / relacionado a:** tarefa 007 (troca do roxo pelo azul, que testou o AA só do acento)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Parte dos textos aparece em cinza ou colorido demais apagado: o nome da entidade sob cada título, as dicas dos campos, os rótulos das fichas, os valores de entrada em verde e os de vencido em vermelho. Para quem enxerga menos, ou com o brilho da tela baixo, esses textos ficam difíceis de ler.

### Evidência e análise técnica
Razões de contraste calculadas pela fórmula do WCAG 2.x (script descartável no rascunho):

| Token (tema) | Sobre | Razão | Onde aparece |
|---|---|---|---|
| `--text-faint` #5e616c (escuro) | `--bg-elev` #171a22 | **2,82** | `.row-sub` (`base.css:650-654`: entidade e caixa sob o título em todas as tabelas), `.hint` (`base.css:303-306`: dicas dos campos), `.money.muted` (`app.css:34-35`), e cerca de 89 usos de `text-faint` nos componentes ("Nenhuma baixa.", "—") |
| `--text-faint` #5e616c (escuro) | `--bg` #111319 | 3,01 | idem, fora dos cartões |
| `--text-faint` #8b8e97 (claro) | #ffffff / #f3f4f8 | 3,27 / 2,98 | idem |
| `--text-muted` #767880 (escuro) | `--bg-elev` | **3,95** | `.kv dt` (`shell.css:795`), `.modal .d` (`shell.css:728`), `.page-head .sub` (`shell.css:347`) |
| `--ok` #3a8963 (escuro) | `--bg-elev` / `--bg` | **4,09** / 4,37 | `.money.in` (`app.css:28-29`): entradas do extrato, a receber |
| `--danger` #d7322d (escuro) | `--bg-elev` / `--bg` | **3,63** / 3,88 | `.money.out` (`app.css:31-32`), `text-danger` do vencimento atrasado (`TitlesTab.tsx:149`) |

Para comparação, `--negative` (5,31) e `--text-dim` (8,01) passam. No tema claro, `--text-muted`, `--ok` e `--danger` passam (4,92 / 5,21 / 5,64). O problema fica no escuro, que é o tema padrão (`index.html:2`), e no `--text-faint` dos dois temas. O texto é pequeno (11,5–13 px), então vale o limite de 4,5:1.

### Verificação (tentativa de refutação)
- `e2e/tests/tema.spec.ts:118-160` confere o AA só do texto sobre o acento e das cores das anotações. `--text-muted`, `--text-faint`, `--ok` e `--danger` constam só na verificação "sem roxo".
- A spec 014 ajustou só o `--negative` para passar no AA. A `docs/001` não isenta o texto secundário.
- `.row-sub` não é decorativo: carrega a entidade, a contraparte e a categoria das linhas.

### Impacto
Todos os usuários do tema escuro, em todas as telas. Pesa mais para quem tem baixa visão e em monitores com pouco brilho.

## Como reproduzir
Abra uma caixa → A pagar no tema escuro. Meça com o DevTools (Inspect → Contrast) a linha cinza sob o título e o valor verde de uma entrada no Extrato.

## Solução proposta
1. Escuro: `--text-muted` para ~#8a8d95 (≈4,9:1 no cartão) e `--text-faint` para ~#7c7f88 (≈4,5:1), mantendo a ordem da rampa. `--ok` para ~#45a374 e `--danger` para ~#e8524c. Recalcular depois de escolher.
2. Claro: `--text-faint` para ~#6f727b.
3. Se o `--text-faint` precisar continuar mais apagado para fios e ícones, crie um `--text-subtle` para o texto e deixe o `--text-faint` só para o que é decorativo.
4. No `tema.spec.ts`, acrescente o AA de `--text-muted`, `--text-faint`, `--ok`, `--danger` e `--negative` sobre `--bg` e `--bg-elev` nos dois temas.

## Critérios de aceite
- [x] Todos os tokens de texto têm razão ≥ 4,5:1 sobre `--bg` e `--bg-elev` nos dois temas.
- [x] O `tema.spec.ts` falha se algum deles cair abaixo disso.

## Testes recomendados
`e2e/tests/tema.spec.ts`: um laço novo com `contrast(parseColor(t[name]), parseColor(t['--bg-elev']))` ≥ 4,5 para os cinco tokens, nos dois temas (os auxiliares `contrast` e `parseColor` já existem no arquivo).

## Limitações e suposições
Contraste calculado a partir dos hex do `tokens.css`, sem medir a tela renderizada (opacidades e misturas podem mudar um pouco os valores). Os tons sugeridos são aproximados e precisam ser recalculados.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado com as razões do WCAG 2.x calculadas dos hex de `apps/web/src/styles/tokens.css`: no escuro, `--text-faint` 2,82 / `--text-muted` 3,95 / `--ok` 4,09 / `--danger` 3,63 sobre o cartão; no claro, `--text-faint` 2,98 sobre o fundo. Achado a mais: o `--warn` do claro (#a8741c), usado como texto em avisos e selos, dava 3,69 sobre o fundo. `e2e/tests/tema.spec.ts` só conferia o AA do texto sobre o acento e das cores das anotações.

## Resolução (executor)
`apps/web/src/styles/tokens.css`, mesma matiz e saturação, só a luminosidade: escuro `--text-muted` #767880 → #9a9ca3, `--text-faint` #5e616c → #838793, `--ok` #3a8963 → #40966d, `--danger` #d7322d → #df5c58; claro `--text-muted` #676a73 → #575a62, `--text-faint` #8b8e97 → #666972, `--ok` #2e7a55 → #2b7350, `--warn` #a8741c → #8e6218. Os neutros continuam no azul-frio (matiz ~225°) e a rampa continua em ordem (dim > muted > faint). Decisão: o alvo foi o AA também sobre o `--surface-2` (campos e linhas em hover), não só sobre `--bg` e `--bg-elev`, e o `--text-faint` ficou como texto (sem um `--text-subtle` à parte), porque os ~170 usos dele são quase todos texto. Os `*-tint` ficaram como estavam. A pior razão agora é 4,60 no escuro (`--ok` sobre o campo) e 4,75 no claro (`--warn` sobre o campo), conferido no Chromium com os tokens reais por um script descartável. `docs/001-stack-e-entrega.md` registra a regra (e corrige a nota da CSP: o markdown saneado não tem mais `style`, tarefa 073).

Testes: `e2e/tests/tema.spec.ts`, nos dois temas: todo token de texto (`--text`, `--text-dim`, `--text-muted`, `--text-faint`, `--ok`, `--warn`, `--danger`, `--negative`, `--info`, `--accent-soft`) com razão ≥ 4,5 sobre `--bg`, `--bg-elev` e `--surface-2`, e a rampa dim > muted > faint (não rodado aqui; o arquivo passa no typecheck). Verificação: `pnpm verify:quick`.
