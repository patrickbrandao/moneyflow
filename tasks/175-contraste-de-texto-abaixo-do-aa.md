---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
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
- [ ] Todos os tokens de texto têm razão ≥ 4,5:1 sobre `--bg` e `--bg-elev` nos dois temas.
- [ ] O `tema.spec.ts` falha se algum deles cair abaixo disso.

## Testes recomendados
`e2e/tests/tema.spec.ts`: um laço novo com `contrast(parseColor(t[name]), parseColor(t['--bg-elev']))` ≥ 4,5 para os cinco tokens, nos dois temas (os auxiliares `contrast` e `parseColor` já existem no arquivo).

## Limitações e suposições
Contraste calculado a partir dos hex do `tokens.css`, sem medir a tela renderizada (opacidades e misturas podem mudar um pouco os valores). Os tons sugeridos são aproximados e precisam ser recalculados.

## Análise (triagem)

## Resolução (executor)
