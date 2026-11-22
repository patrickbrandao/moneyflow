---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Estado das janelas do agente não sincroniza entre abas: a última aba a gravar desfaz o que a outra fechou

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** UX
- **Subcategoria:** estado no `localStorage` sem sincronização (última escrita vence)
- **Arquivos afetados:** `apps/web/src/agents/AgentsProvider.tsx:194,206,290-323`, `apps/web/src/agents/AgentWindows.tsx:216`, `apps/web/src/lib/storage.ts:12-29`
- **Depende de / relacionado a:** tarefa 120 (o `focus` grava a cada clique), tarefa 122 (cada aba abre as mesmas janelas)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Com o MoneyFlow aberto em duas abas, fechar ou minimizar uma janela de agente numa aba não vale para a outra, e basta clicar numa janela da outra aba para a janela fechada "voltar" na próxima vez que a página for aberta.

### Evidência e análise técnica
- `AgentsProvider.tsx:194`: `useStored('agents-ui', INITIAL)` lê o `localStorage` só ao montar; não há ouvinte do evento `storage` (`rg "'storage'" apps/web/src` vazio).
- Cada atualização grava o objeto inteiro (`lib/storage.ts:16-26`), com as janelas que **aquela** aba conhece.
- O `focus` roda em todo clique dentro de uma janela (`AgentWindows.tsx:216`) e grava mesmo sem mudança (`AgentsProvider.tsx:315-323`, ver a tarefa relacionada). Então: aba A fecha a janela W (`close`, `:290-293`, grava sem W); aba B, que ainda tem W, recebe um clique numa janela qualquer e grava o estado com W; ao recarregar qualquer aba, W reaparece. O mesmo vale para doca, painel ancorado, largura do painel e posição.

### Verificação (tentativa de refutação)
- As specs 011 (linha 21) e 026 pedem janelas "persistidas entre páginas e recarregamentos"; não tratam várias abas, mas também não justificam desfazer o que o usuário fez.
- O servidor não guarda esse estado; é só do navegador.

### Impacto
Janelas fechadas ou minimizadas voltando sozinhas, posições trocadas; somado ao SSE por janela e por aba, mais conexões abertas do que o usuário pensa ter.

## Como reproduzir
1. Abrir o console em duas abas com uma janela de agente aberta.
2. Na aba A, fechar a janela.
3. Na aba B, clicar dentro da janela (ainda aberta ali).
4. Recarregar a aba A: a janela fechada está de volta.

## Solução proposta
1. No `AgentsProvider`, ouvir `window.addEventListener('storage', …)` para a chave `agents-ui` e aplicar o novo valor (normalizado) ao estado local.
2. Gravar só quando o estado muda de fato (ver a tarefa do re-render), o que já reduz as sobrescritas.
3. Opcional: guardar só a geometria e o "aberto/minimizado" por janela com carimbo de tempo, juntando por janela em vez de substituir o objeto inteiro.

## Critérios de aceite
- [ ] Fechar ou minimizar numa aba reflete na outra sem recarregar.
- [ ] Clicar numa aba não ressuscita janela fechada na outra.

## Testes recomendados
`e2e/tests/agentes.spec.ts`: dois `page` no mesmo `context`; fechar a janela no primeiro, clicar na janela do segundo, recarregar o primeiro e esperar `agent-window` ausente.

## Limitações e suposições
Nada foi executado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `useStored('agents-ui')` lia o `localStorage` só ao montar, sem ouvir o evento `storage`, e cada atualização gravava o objeto inteiro que aquela aba conhecia; com o `focus` gravando a cada clique (tarefa 120), a aba que ainda tinha a janela fechada noutra a regravava.

## Resolução (executor)

`lib/storage.ts`: `useStored(nome, inicial, { sync: true })` ouve o evento `storage` da chave (só o `localStorage`; `key` nula = `clear()`) e aplica o valor gravado pela outra aba ao estado local, sem gravar de volta. O `AgentsProvider` usa o `sync` no `agents-ui`: fechar, minimizar, ancorar, a largura do painel e a posição feitos numa aba valem nas outras na hora, e a janela que some numa aba desmonta (e fecha o SSE) na outra. Com a tarefa 120, só o que muda é gravado, então um clique noutra aba não regrava nada. O item 3 (juntar por janela com carimbo de tempo) não foi preciso: cada aba grava sempre a partir do último estado de todas.

Testes: e2e novo (não rodado aqui) em `e2e/tests/agentes.spec.ts` → "janelas entre abas (tarefa 183): fechar numa aba vale na outra, e clicar na outra não traz a janela de volta" (dois `page` no mesmo `context`: fechar numa, sumir na outra; abrir na outra, aparecer na primeira; clicar na segunda e recarregar a primeira sem a janela). Spec 011 atualizada. Verificação: `pnpm verify:quick`.
