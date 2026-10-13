# 003 — Entidades, PIX e dados bancários

Entidades são **globais** (cadastradas uma vez, usadas por todas as caixas).

- Pessoa (CPF, dados pessoais) ou Empresa (CNPJ numérico **e alfanumérico**, razão social, nome fantasia).
- Validação dos dígitos de CPF e CNPJ; autopreenchimento de CNPJ (CNPJ Aberto ou BrasilAPI, ver abaixo) e de CEP (ViaCEP).
- Contatos múltiplos (telefones, emails), endereço, anotações, anexos.
- Dados bancários (banco, agência, conta, tipo).
- Chaves PIX: CPF, CNPJ, email, telefone e aleatória (EVP), com validação de formato; várias por entidade, uma principal (mostrada no título a pagar); banco/apelido opcional; botão copiar.
- Vínculos entre entidades (sócio de, responsável por, cônjuge…).
- Uma entidade pode ser titular de caixas (ver [004](004-caixas-e-contas.md)).
- **Tags** (várias por entidade, cada uma com sua cor) e **favoritas**, ambas globais. Ver abaixo.

## Tags

Decisões de 2026-10-13.

- Catálogo **global** de tags de entidade. Cada tag tem nome (1 a 40 caracteres, único sem distinção de maiúsculas, arquivadas inclusive) e **cor** obrigatória: `color_slot` de 1 a 12, pintada com `var(--port-N)` como as categorias (nenhum hex). Não tem ícone. Ao criar, a tela sugere o primeiro slot ainda não usado por uma tag ativa.
- Uma entidade pode ter **várias tags**, sem limite e sem repetição.
- **Permissões**:
  - Só o **admin** cria, renomeia, troca a cor, exclui e restaura tags.
  - Quem edita o cadastro (`canEditRegistry`: admin ou editor de alguma caixa) **atribui e remove** tags das entidades.
  - O viewer vê as tags e filtra por elas.
- **Excluir** segue a regra geral ([008](008-categorias-auditoria-e-exclusao.md)), por `deleteOrArchive`:
  - Uma tag sem uso é apagada.
  - Uma tag em uso é **arquivada**: continua nas entidades que já a têm (esmaecida e com "(arquivada)"), mas sai do seletor e do filtro e não pode ser atribuída de novo (o banco recusa).
  - Quem edita o cadastro pode remover uma tag arquivada de uma entidade.
  - Restaurar a tag a devolve ao seletor e ao filtro.
- **Gestão das tags**: botão **Tags** na página de Entidades, visível só para o admin. Ele abre um modal com a lista de tags (cor, nome, quantas entidades a usam), criar, editar, excluir/arquivar e uma seção "Arquivadas" com restaurar. O admin também cria uma tag direto no seletor do formulário da entidade (digita um nome que não existe → "Criar tag 'X'", com a cor sugerida).
- **Na entidade**:
  - O formulário (criar e editar) tem o seletor de tags: lista com busca, uma bolinha de cor por tag e as escolhidas como chips removíveis.
  - A ficha mostra as tags como chips (bolinha da cor + nome) ao lado do nome.
  - Atribuir e remover tags é auditado como alteração da entidade.
- Rotas:
  - `GET /api/entity-tags` (todas as ativas, com `usageCount`; `?archived=1` traz também as arquivadas).
  - `POST /api/entity-tags`, `PATCH /api/entity-tags/:id`, `DELETE /api/entity-tags/:id` (`DeleteResult` deleted/archived) e `POST /api/entity-tags/:id/restore` (só admin).
  - A entidade recebe e devolve `tagIds` no criar/editar e `tags` (`{id, name, colorSlot, archived}`) no resumo e no detalhe. `tagIds` no PATCH substitui o conjunto inteiro.

## Favoritas

- A marca de favorita é **global**: um campo da entidade (`is_favorite`), igual para todos os usuários.
- Marca e desmarca quem edita o cadastro (`canEditRegistry`), com uma **estrela** na linha da listagem e na ficha (e `isFavorite` no PATCH). É auditado como alteração da entidade. Para o viewer, a estrela aparece só como indicação, sem clique.
- Entidade arquivada mantém a marca, mas não aparece na aba Favoritas (a listagem padrão esconde as arquivadas).

## Listagem de entidades

- Abas: **Favoritas** | Todas | Pessoas | Empresas.
  - **Favoritas é a aba inicial**: sem `kind` na URL abre Favoritas; `?kind=all`, `?kind=person` e `?kind=company` abrem as outras.
  - Sem nenhuma favorita, a aba mostra um aviso ("Nenhuma entidade favorita. Marque com a estrela…") e um atalho para Todas.
- **A busca procura em todas as entidades**: com texto digitado, a aba Favoritas mostra o resultado em todas, com as favoritas primeiro e um aviso "Buscando em todas as entidades". As abas Pessoas e Empresas continuam restringindo o tipo.
- **Filtro por tags**:
  - Um seletor de várias tags (só as ativas) ao lado das abas, combinado com a aba e com a busca.
  - Modo **Qualquer uma** (OU, padrão: a entidade tem pelo menos uma das tags) ou **Todas** (E: a entidade tem todas).
  - Fica na URL: `?tags=<id>,<id>&tagMode=any|all`.
- Colunas: estrela, nome (com fantasia), **tags** (chips; acima de 3, "+N"), documento, PIX principal e caixas.
- A exportação CSV/PDF da listagem leva as colunas **Favorita** (Sim/Não) e **Tags** (nomes separados por vírgula).
- API: `GET /api/entities` ganha `favorites=1` (só favoritas), `tagIds=<id>,<id>` e `tagMode=any|all` (padrão `any`). Com `q`, a ordenação põe as favoritas primeiro e depois a similaridade.
- **Seletor de entidade** (`EntityPicker`, nos títulos, contratos, espelho etc.):
  - Com a busca vazia, lista primeiro as favoritas (até 8) e completa com as demais por nome, até 8 opções.
  - Com texto, as favoritas vêm primeiro entre os resultados.
  - Cada opção mostra a estrela e as bolinhas de cor das tags.

## Filtro por entidade em relatórios e canvas

O mesmo filtro (tags com Qualquer uma/Todas e **Só favoritas**) aparece em todos os relatórios e no canvas ([014](014-visualizacao-e-relatorios.md)). A API resolve o filtro numa lista de entidades e a passa às funções do banco.

## CNPJ alfanumérico em todo o sistema

O CNPJ alfanumérico (IN RFB 2.229/2024, emitido desde julho de 2026) vale em **todo** lugar que recebe, guarda, procura ou mostra um CNPJ:

- **Formato**: 14 caracteres. Os 12 primeiros são `[0-9A-Z]` e os 2 últimos, os DVs, são numéricos. Cada caractere vale o código ASCII − 48, com pesos de 2 a 9 a partir da direita, módulo 11 (resto < 2 → 0). Não pode ter os 14 caracteres iguais.
- **Normalização**: `normalizeDocument` (shared) põe em maiúsculas e remove tudo que não for `[0-9A-Z]` (pontos, barra, hífen, espaços). Tudo que chega de fora passa por ela antes de validar, gravar ou comparar: digitação, API, tools, MCP, NF-e, BR Code, leitura por IA, extrato e backup. O banco guarda e valida só a forma normalizada (`is_valid_cnpj` recusa minúsculas; [016](016-banco-de-dados.md)).
- **Validação**: a mesma regra no shared (`isValidCnpj`) e no banco (`is_valid_cnpj`), cobertas pelos mesmos casos de teste. O exemplo da Receita é `12.ABC.345/01DE-35`.
- **Nada trata CNPJ como número**: nenhum `\D`/`replace(/\D/g, '')`, `inputMode="numeric"`, máscara só de dígitos, `parseInt`/`Number` ou cast numérico sobre CNPJ. Remover os não dígitos só vale onde a regra é numérica por natureza: boleto, CEP, telefone e CPF.
- **Entrada na tela**:
  - Os campos de documento e de chave PIX aceitam letras e as convertem para maiúsculas enquanto se digita.
  - A máscara aplica `00.000.000/0000-00` a qualquer caractere alfanumérico.
  - O placeholder mostra os dois formatos (`00.000.000/0000-00 ou 12.ABC.345/01DE-35`).
  - A chave PIX do tipo CNPJ aparece formatada como o documento.
- **Busca**: a busca da listagem, do `EntityPicker` e do `search_records` dos agentes ([011](011-agentes-de-ia.md)) normaliza o texto e procura pelo prefixo do documento (com ou sem pontuação, maiúsculas ou minúsculas). Isso vale também no fallback sem embeddings.
- **Chave de acesso da NF-e**: segue a NT 2025.001 ([010](010-entrada-de-titulos.md)). As posições 7 a 20, o CNPJ do emitente, aceitam `[0-9A-Z]`, e o DV usa ASCII − 48.
- **BR Code e chave PIX**: a chave CNPJ alfanumérica é reconhecida (`guessPixKeyType`), normalizada e casada com a entidade como a numérica.
- **Extrato e conciliação**: a normalização da descrição (`normalizeDescription`) descarta o CNPJ alfanumérico (token de 14 caracteres com DV válido) como já descarta o numérico, para que as regras de classificação e o casamento tratem os dois formatos igual.
- **Consulta de CNPJ**: a API valida o CNPJ (`isValidCnpj`) antes de chamar qualquer provedor; inválido vira 400 "CNPJ inválido", sem gastar requisição. O roteamento está abaixo.
- **Testes obrigatórios com CNPJ alfanumérico (inclusive digitado em minúsculas e com pontuação)**:
  - Criar, editar e detectar duplicata de entidade pela API.
  - Chave PIX e BR Code com chave CNPJ alfanumérica.
  - NF-e com emitente, destinatário e chave de acesso alfanuméricos.
  - Casar a importação do backup pela chave natural.
  - `search_records` e a busca da listagem.
  - pgTAP de `is_valid_cnpj` e `is_valid_nfe_access_key`.
  - Um e2e que cadastra uma empresa com CNPJ alfanumérico e a encontra pela busca.

## Consulta de CNPJ

O botão **Buscar CNPJ** do cadastro de empresa chama `GET /api/lookup/cnpj/:cnpj` (exige sessão), que preenche razão social e nome fantasia e oferece incluir endereço (como "Sede"), e-mail e telefone. A resposta diz qual provedor respondeu (`source`) e a situação cadastral na Receita (`registrationStatus`); se ela não for "Ativa" (Inapta, Suspensa, Baixada…), o formulário mostra um aviso, sem impedir o cadastro.

- **CNPJ Aberto** (`https://cnpjaberto.com.br/api/cnpj/{cnpj}`, documentação em `/api-docs`): ligado por `CNPJ_ABERTO_ENABLED=true`, com a chave em `CNPJ_ABERTO_API_KEY` (cabeçalho `X-API-Key`). Ligado sem chave, a API não sobe. Usa o estabelecimento do CNPJ pedido (matriz ou filial). Só aceita os 14 dígitos (a documentação dele diz "14 dígitos, só números"): o CNPJ alfanumérico vai direto à BrasilAPI. Se o CNPJ Aberto passar a aceitar letras, basta mudar esse roteamento. Plano gratuito: 200 requisições por dia.
- **BrasilAPI** (`/api/cnpj/v1/{cnpj}`, que aceita o CNPJ alfanumérico desde agosto de 2026): o provedor quando o CNPJ Aberto está desligado e o fallback quando ele falha — rede, timeout, chave recusada (401), limite atingido (429) ou erro 5xx. CNPJ inexistente no CNPJ Aberto (404) é resposta final, sem fallback.
- Inexistente vira 404 ("Nada encontrado para esse número"); provedores fora do ar viram 503 ("preencha à mão"). Timeout em `LOOKUP_TIMEOUT_MS`.
- A chave do CNPJ Aberto é segredo como as demais: fica fora do git (em `.local/cnpjaberto.env`, carregado pelo compose da raiz no serviço `api` e pelo `pnpm dev`), nunca é devolvida pela API nem aparece em logs (o aviso de fallback registra só o status). Em produção, vem do ambiente do projeto externo.
- `CNPJ_ABERTO_BASE` e `BRASILAPI_BASE` trocam os endereços (provedores falsos nos testes).
