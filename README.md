# MoneyFlow

Sistema multiusuário de finanças por **caixa**: contas a pagar e a receber, contas financeiras com conciliação de extrato (OFX/CSV), cartões de crédito com faturas, várias casas e empresas no mesmo lugar, o canvas do fluxo de dinheiro entre caixas e entidades, relatórios, avisos pelo Telegram e **agentes de IA** que consultam e operam o sistema com as permissões de quem os aciona.

- **Caixa**: o livro financeiro de um titular (pessoa ou empresa), unidade de permissão.
- **Título**: a pagar ou a receber, liquidado por baixas; quando a contraparte também tem caixa, o lado oposto é espelhado nela.
- **Cartão de crédito**: uma caixa própria; a fatura vira um título em cada caixa pagadora.
- **Contrato**: documento e vínculo com uma entidade (vigência, documentos em PDF e markdown) cujas obrigações são séries recorrentes nas contas ou no cartão.
- **Agentes**: janelas de conversa com tools de leitura e escrita (o kit de ferramentas do agente diz quais rodam direto e quais pedem "Aplicar?" com o diff), MCP client e um servidor MCP próprio em `/mcp`.

Stack: monorepo pnpm, Node/TypeScript (Fastify, Drizzle), React 19 + Vite, PostgreSQL 18 com pgvector, imagem Docker única `tmsoftbrasil/moneyflow`.

## Subir com Docker

Requisitos: Docker com Compose v2.

```bash
cp .env.example .env          # ajuste senhas e o admin inicial (ADMIN_*)
docker compose up --build -d  # Postgres (porta 5433), migrations, API + console e worker
```

O console fica em <http://localhost:3000> (porta em `APP_PORT`). A pilha tem quatro serviços: `postgres`, `migrate` (aplica as migrations e sai), `api` (serve a API e o SPA) e `worker` (séries recorrentes, faturas, mensagens e a execução dos agentes de IA). Para parar: `docker compose down` (os dados ficam no volume; `down -v` apaga).

## Primeiro acesso

No primeiro boot, se não houver usuários, a API cria o administrador com `ADMIN_USERNAME`, `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`. Entre com esse usuário e:

1. troque a senha em **Minha conta**;
2. cadastre as entidades titulares (pessoas e empresas) em **Entidades**;
3. crie as caixas e as contas financeiras em **Caixas**;
4. crie os demais usuários em **Usuários** e dê acesso às caixas (editor ou leitor).

## Configurar um provedor de IA e um agente

Em **Administração → IA e agentes** (só admin):

1. **Provedores**: escolha *Anthropic (Claude API)* ou *OpenAI ou compatível* e informe a chave de API (fica guardada no banco e nunca é mostrada de novo). Com a URL base vazia, é a API oficial; preenchida, um servidor compatível (OpenRouter, Azure, Ollama…; no tipo OpenAI, terminando em `/v1`), e o Anthropic compatível exige o modelo de texto padrão. Marque as **capacidades** (texto, visão, embeddings, áudio→texto, texto→áudio), cada uma com o modelo padrão, e use **Testar conexão**, que confere capacidade por capacidade e lista os modelos.
2. **Preços** (opcional): preço por milhão de tokens (e de áudio) por modelo, para o custo estimado no painel de uso.
3. **Kit de Ferramentas**: as tools que o agente pode usar e, para cada uma, se roda direto (`allow`) ou pede aprovação (`ask`). Agente sem kit tem todas as tools internas, sem pedir aprovação (só as de segredo pedem sempre, e as de administrador valem só para quem é admin): para dar menos poder, crie um kit. As tools dos servidores MCP não passam pelo kit e pedem aprovação, salvo as marcadas como só leitura.
4. **Agentes**: nome, prompt de sistema (com variáveis e histórico de versões), o **Provedor padrão** (preenche o provedor de texto e as inferências que ele suporta, cada uma trocável depois), o modelo (sugestões: `claude-sonnet-5-5` para o dia a dia, `claude-opus-5-5` para análises pesadas), o kit de ferramentas, cor e servidores MCP. Ative o agente.
5. **Servidores MCP** (opcional): URL Streamable HTTP, cabeçalhos secretos (ex.: `Authorization`), visibilidade (`global`, `public`, `private`) e o que fazer com as instruções do servidor; **Testar e atualizar tools** lê a lista de tools do servidor.
6. **Uso** e **Requisições** (opcional): orçamentos mensais, o limite de execuções por minuto, o painel de uso e o registro das chamadas ao provedor.

Depois disso, o ícone **Agentes** na barra superior abre as sessões de cada agente. O agente marcado em **Agentes → Usar nos fluxos automáticos** (ou, sem marca, o primeiro agente ativo) também lê PDFs e imagens de boletos e notas na criação de títulos, sugere a classificação das linhas de extrato importadas, concilia o lote com IA ao importar (quando ligado na conta) e lê os PDFs dos contratos. Cada usuário pode criar tarefas agendadas para os agentes em **Minha conta**. A variável `AI_FLOW_AGENT` deixou de existir: quem a usava marca o agente nessa opção.

Para usar as tools do MoneyFlow num cliente MCP externo, gere um token em **Minha conta → Tokens de API** (o admin gera para qualquer usuário em **Administração → Controle MCP**) e configure o cliente com `https://<seu-host>/mcp` e o cabeçalho `Authorization: Bearer <token>`. O token tem as permissões do dono.

## Configurar um destino do Telegram

1. Crie um bot com o [@BotFather](https://t.me/BotFather) e copie o token.
2. Mande uma mensagem ao bot (ou adicione-o ao grupo) e descubra o `chat_id` (por exemplo, pela API `getUpdates` do bot).
3. Em **Mensagens → Novo destino**, informe nome, token e chat id (pessoal ou de uma caixa) e use **Enviar teste**.
4. Na gaveta do destino, escolha os eventos: vencimentos, atrasados, resumos, fatura fechada, limite do cartão, divergência de conciliação e os avisos dos agentes.

O token do bot também é write-only. Para os links das mensagens apontarem para o console, defina `APP_URL`. Para conversar com os agentes pelo Telegram, ligue **Receber mensagens** no destino (exige a URL pública HTTPS da API em `PUBLIC_BASE_URL` ou em **Administração → IA e agentes → Tarefas e Telegram**) e pareie o seu chat em **Minha conta → Telegram**.

## Desenvolvimento

Requisitos: Node 26 (o `.nvmrc`) e pnpm 9.12. Os comandos (instalação, banco de desenvolvimento, `pnpm dev`, os dois níveis de verificação, testes unitários, de integração e e2e, build e release) estão em [AGENTS.md](AGENTS.md), e o mapa de cada pacote no `AGENTS.md` da pasta. O banco (`database/`) tem regras e comandos próprios em [database/AGENTS.md](database/AGENTS.md). As variáveis de ambiente estão todas no [.env.example](.env.example).

## Especificações

As especificações do produto, fonte da verdade de cada decisão, estão em [`docs/`](docs/INDEX.md): veja o índice [docs/INDEX.md](docs/INDEX.md), com os conceitos centrais e uma frase por especificação.
