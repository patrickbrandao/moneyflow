# 014 — Visualização e relatórios

## Canvas de fluxo (React Flow)
- Nós: caixas (hubs, com saldo) e entidades externas (folhas, agrupadas por categoria quando forem muitas).
- Arestas: valor que fluiu no período, com espessura proporcional, cor por tipo (pagamento, recebimento, transferência, fatura) e tracejado animado para o previsto.
- O clique abre a gaveta com os movimentos. Posições salvas por usuário, com auto-layout inicial.

### Decisões (F3)
- Página-palco `/flow` com filtros na URL: período (atalhos mês, mês passado, 3 meses, ano; padrão o mês corrente), caixas (vazio = todas as legíveis; a API inclui os cartões cuja pagadora padrão está na seleção) e **realizado / previsto / realizado + previsto** (padrão os dois).
- Dados do banco: `flow_graph_nodes/edges/lines` (docs/016) com só as caixas legíveis. Caixa fora da seleção aparece como o nó do titular (entidade).
- **Layout**: colunas — à esquerda as entidades que mais mandam dinheiro, no centro as caixas gerais, depois os cartões, à direita as entidades que mais recebem. Arrastar grava a posição do nó para o usuário (`canvas_node_positions`, layout `default`, debounce de 400 ms); "Reorganizar" apaga as posições e volta ao auto-layout.
- **Agrupamento**: com mais de 12 entidades, as do mesmo grupo de categoria (a de maior volume da entidade) e do mesmo lado viram um cluster quando são 3 ou mais; a gaveta do cluster tem "Expandir grupo".
- **Arestas**: uma por origem, destino e tipo (pagamento, recebimento, transferência, fatura, compra no cartão); espessura pela raiz do valor; cor por tipo com os tokens `--port-N`; previsto tracejado e animado (parado com `prefers-reduced-motion`); no modo "realizado + previsto" o previsto corre ao lado do realizado. Entre caixas da mesma coluna a aresta sai por baixo/cima.
- **Destaque por tags e favoritas** (2026-10-13):
  - O canvas tem o mesmo filtro de entidades dos relatórios (tags com Qualquer uma/Todas e Só favoritas, na URL), mas ele **destaca sem esconder**: o grafo continua inteiro.
  - Ficam em destaque os nós de entidade que casam, as arestas que tocam ao menos um deles e as caixas ligadas a essas arestas. O resto fica esmaecido (opacidade reduzida por token, sem tirar as cores) e continua clicável.
  - Um cluster fica em destaque se algum membro casar, e a gaveta do cluster marca quais membros casam.
  - O filtro é só do navegador: a API do grafo (`flow_graph_nodes`) acrescenta `tagIds` e `isFavorite` aos nós de entidade, numa consulta da aplicação, sem mudar as funções do banco. O layout e as posições salvas não mudam com o filtro.
  - Um nó de caixa fora da seleção aparece como o titular (entidade) e também pode casar.
- **Gaveta**: nó (saldo ou limite usado, entradas e saídas realizadas e previstas, abrir a caixa/entidade) ou aresta (origem → destino, totais) e a lista de lançamentos (`flow_graph_lines`), cada um com link para o registro: título (baixa ou previsto), fatura, compra do cartão, transferência ou extrato da conta (ajuste).

## Relatórios
- Despesa/receita por categoria (por caixa ou consolidado, mês a mês, variação, ranking). Por **competência**, as despesas do cartão entram pelas compras (data da compra, categoria e pagadora de cada uma) e os títulos de fatura (`card_invoice`) ficam de fora, para não contar duas vezes ([007](007-cartao-de-credito.md)).
- Fluxo de caixa projetado (30/60/90 dias, por caixa e por conta).
- Por entidade, incluindo o rastreio até o recebedor final via cartão.
- Export CSV/PDF de relatórios e listagens.

### Decisões (F3)
- Tela `/reports` com abas **Por categoria**, **Fluxo projetado** e **Por entidade**; filtros na URL. Regime **competência** (padrão) ou **caixa** ([008](008-categorias-auditoria-e-exclusao.md)); período padrão: os últimos 6 meses até o fim do mês corrente.
- **Regime de caixa**: o pagamento da fatura conta como pagamento do título da pagadora, com a categoria do título da fatura (origem `card_invoice_payment`), sem ratear pelas compras; os lojistas aparecem na competência ([007](007-cartao-de-credito.md)). Transferências nunca contam.
- **Consolidado** soma as caixas escolhidas e **descarta** as linhas `is_internal` (espelho cuja outra ponta também está na seleção: o dinheiro só circulou entre elas). **Por caixa** mostra uma caixa só, com as linhas internas (que são despesa/receita reais dela).
- Por categoria: gráfico de barras empilhadas por mês (os 7 maiores grupos + "Outras", cor da categoria), ranking das 10 subcategorias de maior valor e a árvore grupo → subcategoria com os meses, total, **variação** (último mês do período contra o anterior; em despesa subir é vermelho) e a parte do total.
- Fluxo projetado: por caixa geral, colunas por horizonte (30/60/90): saldo de hoje, lançados (movimentos já registrados no futuro), a receber, a pagar, vencidos e o projetado; nas contas só o realizado. Cartões entram pela fatura na pagadora.
- Por entidade: pago, recebido, saldo e lançamentos, com o rastreio caixa pagadora → cartão → recebedor final e a origem (título, compra no cartão, baixa, pagamento de fatura, ajuste).
- **Filtro por entidade** (2026-10-13; tags e favoritas em [003](003-entidades.md)):
  - As três abas ganham o filtro de entidades: tags (Qualquer uma/Todas) e **Só favoritas**. Fica na URL: `tags`, `tagMode`, `favorites=1`.
  - A API resolve o filtro numa lista de entidades (só tags ativas; as duas condições juntas = interseção; arquivadas inclusive, porque o histórico delas conta) e passa `p_entity_ids` às funções do banco ([016](016-banco-de-dados.md)). Sem filtro, o comportamento continua o de hoje.
  - Na API dos relatórios, o filtro vai em `tagIds=<id>,<id>`, `tagMode=any|all` e `favorites=1` (como em `GET /api/entities`), e a resposta traz `entityFilter`: `null` sem filtro ou `{ entityCount }`, quantas entidades casaram.
  - Filtro que não casa nenhuma entidade dá um relatório vazio, com o aviso "Nenhuma entidade com esse filtro".
  - **Por categoria**: só as linhas cuja contraparte está na lista. Na competência são os títulos da entidade e as compras do cartão pelo **recebedor final**. No regime de caixa são as baixas dos títulos da entidade e os ajustes com essa entidade. O pagamento de fatura (`card_invoice_payment`) e as linhas sem entidade ficam de fora enquanto houver filtro, porque não têm uma contraparte única.
  - **Por entidade**: só as entidades da lista. O rastreio do cartão vale pelo recebedor final.
  - **Fluxo projetado**: o **saldo de hoje** continua o da caixa ou conta inteira (é o que há no banco). "Lançados", "a receber", "a pagar" e "vencidos" contam só os movimentos e títulos das entidades da lista, e o "projetado" é o saldo de hoje + esses valores. As faturas abertas ficam de fora com filtro. A tela avisa: "Saldo de hoje da caixa inteira; os lançamentos consideram só as entidades filtradas".
  - O CSV/PDF exportado registra o filtro no cabeçalho (tags, modo, só favoritas): no CSV, uma linha antes do cabeçalho das colunas (`preamble` da tabela neutra); no PDF, no subtítulo.
- **Exportação**: CSV e PDF gerados **no navegador** a partir da mesma tabela neutra (`packages/shared/src/export.ts`). CSV no padrão do Excel pt-BR: separador `;`, CRLF, UTF-8 com BOM, dinheiro `1234,56`, datas `dd/mm/aaaa`, proteção contra injeção de fórmula. PDF com jsPDF + jspdf-autotable, carregados sob demanda (não pesam no bundle inicial), A4 (paisagem com mais de 6 colunas), fontes padrão. Exportam: os três relatórios e as listagens de títulos, extrato, compras do cartão e entidades (com os filtros da tela, até o limite da API: 500 títulos e entidades, 1000 compras).
