# e2e — Playwright

Guia da pasta `e2e` (`@moneyflow/e2e`). As regras gerais estão no [AGENTS.md da raiz](../AGENTS.md). Os testes rodam contra a pilha no ar, um arquivo por vez (`workers: 1`), e entram na verificação completa com `pnpm verify:full --e2e`.

## Como rodar

```bash
docker compose up --build -d                     # a pilha da raiz (http://localhost:3000)
pnpm e2e                                         # todos (E2E_BASE_URL, padrão http://localhost:3000)
pnpm --filter @moneyflow/e2e exec playwright test -g "baixa"   # um teste
# Os e2e de mensagens sobem uma Bot API falsa na porta 18081 (E2E_TELEGRAM_PORT): suba a pilha apontando para ela
TELEGRAM_API_BASE=http://host.docker.internal:18081 docker compose up --build -d
node e2e/fakes/fake-llm.ts 18082        # o provedor de IA falso, à mão, para testar o console (Anthropic: base_url http://host.docker.internal:18082)
node e2e/fakes/fake-telegram.ts 18081   # a Bot API falsa, à mão (setWebhook, getFile e o download, botões; nada vai ao Telegram)
```

- Os e2e de agentes sobem o provedor falso na porta 18082 (`E2E_LLM_PORT`) e o cadastram com `base_url` `http://host.docker.internal:18082` (`E2E_LLM_BASE`); nada chama uma API de IA real.
- O Telegram de entrada (`visao.spec.ts`) sobe outro provedor falso na 18083 (`E2E_LLM_TELEGRAM_PORT`, `E2E_LLM_TELEGRAM_BASE`) e chama o webhook direto, com o segredo que a Bot API falsa recebeu no `setWebhook`.
- Credenciais do admin: `E2E_USERNAME`/`E2E_PASSWORD`, ou `ADMIN_USERNAME`/`ADMIN_PASSWORD`.

## Arquivos

- `playwright.config.ts`: a instância já no ar (`E2E_BASE_URL`) e `workers: 1`. O microfone falso do Chromium (`--use-fake-device-for-media-stream`) é ligado no próprio `agentes.spec.ts`, para o arquivo todo.
- `global-setup.ts`: desliga as sobras de uma execução interrompida (o agente e o provedor "E2E…", tarefa 125) e abre a sessão do admin uma vez (`e2e/.auth/`, fora do git); os testes a reaproveitam com `loginAsAdmin` (`support/session.ts`), porque o login tem limite por minuto (`LOGIN_RATE_LIMIT`). O login pela tela fica em `fluxo-principal` e `contratos`.
- `fakes/fake-llm.ts`: o provedor de IA falso (Anthropic Messages e OpenAI, com embeddings e áudio), também usado pela integração da API; `fakes/fake-telegram.ts`: a Bot API falsa, a mesma dos testes de integração. Os dois são conferidos por `apps/server/test/e2e-fakes.test.ts`.

## Specs (`tests/`)

- `fluxo-principal.spec.ts`: login → entidade → título → baixa.
- `operacao.spec.ts`: importar um OFX e conciliar (o lançamento da linha com o espelho noutra caixa), a conciliação (título da caixa, última conta lembrada, aplicar regras, buscar nos lotes), o saldo do lote, as regras por conta (spec 032: criar na corrente, não aparecer na poupança e copiar pelo modal) e fechar a fatura do cartão e pagar.
- `conciliacao-provisoria.spec.ts` (spec 031): importar o consolidado substituindo o provisório conciliado, as conciliações no consolidado, excluir a sobra e o provisório substituído fora da divergência.
- `contratos.spec.ts` e `contratos-pagamentos.spec.ts` (spec 034): criar pela tela o contrato com a obrigação na corrente, o OFX com o pagamento sugerindo a ocorrência (com multa e juros no atrasado), confirmar e ver a ocorrência paga e o atraso na guia Pagamentos, renovar, e o cofre com os Previstos e o "É o pagamento de…?" baixando a ocorrência.
- `conta.spec.ts` (spec 004): abrir a conta pela faixa da caixa, números só da conta, Resumo com gráficos e pizzas, Extrato preso na conta (período lembrado, negativo no formato contábil), Conciliação com os lotes dela, trocar de conta e voltar para a caixa.
- `visao.spec.ts`: canvas e gaveta, relatório por categoria e CSV, destino do Telegram com "Enviar teste" (Bot API falsa) e o Telegram de entrada (ligar a entrada, parear pelo código e trocar mensagens).
- `agentes.spec.ts`, com o provedor falso:
  - conversa, aprovar escrita, ancorar e minimizar, recusar com motivo, markdown seguro, acessibilidade, sessões (finalizar, sessão nova, anterior em leitura, bifurcar e a conversão do `localStorage` antigo), reconexão do SSE com `Last-Event-ID` e a queda do stream do provedor, janelas entre abas, o admin lendo a sessão de outro usuário em somente leitura;
  - "Usar nos fluxos automáticos" e as sugestões da conciliação em lote;
  - kit de ferramentas (marcar a Conciliação, uma escrita em ask, ligar ao agente e aprovar o cartão);
  - controle total (anexar um OFX e pedir "importe e concilie", "crie um kit só de leitura", o cartão de segredo trocando a chave de um provedor);
  - tarefa agendada com "Rodar agora" e a aprovação pelo sino; conciliação com IA ao importar e o lote aprovado;
  - prompt (editar, histórico com diff, restaurar, variáveis, "Ver prompt montado") e Minha conta → IA;
  - orçamentos (aviso no sino e a conversa recusada); requisições (429 seguido de 200, detalhe do provedor, gaveta com as tentativas, retenção);
  - capacidades (provedor falso com todas as flags);
  - áudio (transcrição, 2x, modo áudio), prévias de imagem, PDF e markdown e a gravação pelo microfone falso.
- `anotacoes.spec.ts` (spec 035): lembretes do próximo minuto disparados pelo worker, o alarme com o `play()` trocado por um dublê (autoplay recusado e liberado no clique), adiar, dispensar e marcar todos, o calendário anual e mensal, o dia filtrando a tabela, a janela com o lembrete mensal, a aba da entidade e o selo.
- `tags.spec.ts`: criar tag, atribuir, estrela, aba Favoritas e filtro por tag.
- `cnpj-alfanumerico.spec.ts`: cadastrar digitando em minúsculas e achar pela busca; `cnpj-consulta.spec.ts`: trocado o documento, o endereço da consulta anterior não entra (tarefa 177).
- `backup.spec.ts`: exportar as categorias e simular a importação.
- `tema.spec.ts`: acento azul, nada roxo, AA (texto, estados, anotações) e as 12 `--port-N` distintas.
- `carga.spec.ts`: a visão geral não baixa as outras telas; o menu e a paleta trazem cada uma no seu pedaço (tarefa 128). Confere os nomes do build (`/assets/<Nome>-<hash>.js`): rode contra a pilha compilada, não contra o Vite de desenvolvimento.
- `sessao.spec.ts`: a sessão que cai com o console aberto (o formulário fica, o login abre por cima, o salvar é repetido; tarefa 119).
- `respostas.spec.ts`: a prévia do "Encerrar série" da data na tela, a resposta lenta da auditoria que não substitui a atual e os títulos além da página ("Mostrando N de M", "Carregar mais"; tarefas 116–118).
- `teclado.spec.ts`: o Esc pela pilha de camadas (tarefa 115) e as listas pelo teclado (tarefa 114).
