# 003 — Entidades, PIX e dados bancários

Entidades são **globais** (cadastradas uma vez, usadas por todas as caixas).

- Pessoa (CPF, dados pessoais) ou Empresa (CNPJ numérico **e alfanumérico**, razão social, nome fantasia).
- Validação dos dígitos de CPF e CNPJ; autopreenchimento de CNPJ (CNPJ Aberto ou BrasilAPI, ver abaixo) e de CEP (ViaCEP).
- Contatos múltiplos (telefones, emails), endereço, anotações, anexos.
- Dados bancários (banco, agência, conta, tipo).
- Chaves PIX: CPF, CNPJ, email, telefone e aleatória (EVP), com validação de formato; várias por entidade, uma principal (mostrada no título a pagar); banco/apelido opcional; botão copiar.
- Vínculos entre entidades (sócio de, responsável por, cônjuge…).
- Uma entidade pode ser titular de caixas (ver [004](004-caixas-e-contas.md)).

## Consulta de CNPJ

O botão **Buscar CNPJ** do cadastro de empresa chama `GET /api/lookup/cnpj/:cnpj` (exige sessão), que preenche razão social e nome fantasia e oferece incluir endereço (como "Sede"), e-mail e telefone. A resposta diz qual provedor respondeu (`source`) e a situação cadastral na Receita (`registrationStatus`); se ela não for "Ativa" (Inapta, Suspensa, Baixada…), o formulário mostra um aviso, sem impedir o cadastro.

- **CNPJ Aberto** (`https://cnpjaberto.com.br/api/cnpj/{cnpj}`, documentação em `/api-docs`): ligado por `CNPJ_ABERTO_ENABLED=true`, com a chave em `CNPJ_ABERTO_API_KEY` (cabeçalho `X-API-Key`). Ligado sem chave, a API não sobe. Usa o estabelecimento do CNPJ pedido (matriz ou filial). Só aceita os 14 dígitos: o CNPJ alfanumérico vai direto à BrasilAPI. Plano gratuito: 200 requisições por dia.
- **BrasilAPI** (`/api/cnpj/v1/{cnpj}`): o provedor quando o CNPJ Aberto está desligado e o fallback quando ele falha — rede, timeout, chave recusada (401), limite atingido (429) ou erro 5xx. CNPJ inexistente no CNPJ Aberto (404) é resposta final, sem fallback.
- Inexistente vira 404 ("Nada encontrado para esse número"); provedores fora do ar viram 503 ("preencha à mão"). Timeout em `LOOKUP_TIMEOUT_MS`.
- A chave do CNPJ Aberto é segredo como as demais: fica fora do git (em `.local/cnpjaberto.env`, carregado pelo compose da raiz no serviço `api` e pelo `pnpm dev`), nunca é devolvida pela API nem aparece em logs (o aviso de fallback registra só o status). Em produção, vem do ambiente do projeto externo.
- `CNPJ_ABERTO_BASE` e `BRASILAPI_BASE` trocam os endereços (provedores falsos nos testes).
