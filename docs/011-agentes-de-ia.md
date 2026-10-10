# 011 — Agentes de IA

## Configuração
- **Provedores**: multi-provedor, cadastrados pelo admin (chaves no servidor). Claude API é o padrão; OpenAI API é suportada. Cada agente escolhe provedor e modelo.
- **Agentes**: criados **só pelo admin** (nome, system prompt, provedor/modelo, tools, MCPs).
- **Tools**: gestão completa do sistema, sempre dentro das permissões do usuário que aciona o agente. Definidas uma vez em `packages/shared`. A leitura executa direto; a escrita mostra um cartão "Aplicar?" com o diff (e aprovar tudo para lotes). Confirmação configurável por agente. A tool "enviar mensagem" também passa por confirmação.

## MCP
- **MCP client** (só Streamable HTTP, sem stdio), servidores cadastrados pelo admin com uma visibilidade:
  - `global`: entra automaticamente em todos os agentes;
  - `public`: disponível para ser escolhido na configuração de qualquer agente;
  - `private`: só os agentes a que o admin o vincular explicitamente.
- **MCP server próprio**: endpoint `/mcp` expondo as mesmas tools, autenticado por token pessoal do usuário e com as permissões dele.

## Execução, histórico e custo
- O loop do agente roda no worker, com streaming via SSE; fechar a janela não interrompe, e um aviso no sino informa a conclusão.
- Conversas do usuário com título automático, renomear, fixar, arquivar, excluir, buscar e bifurcar. **O admin pode ler as conversas de todos.**
- Tokens e custo estimado por mensagem, agente e usuário (só medição, sem teto).

## UX das janelas
- Várias janelas flutuantes (arrastar, redimensionar, minimizar numa doca no rodapé), persistidas entre páginas e recarregamentos; cada janela é uma conversa.
- O agente recebe o contexto da tela (caixa aberta, registro selecionado, filtros); dá para arrastar um registro para dentro da janela.
- **Um** agente por vez pode ser ancorado como **painel lateral direito**, com o comportamento da sidebar esquerda: colapsar, expandir, alargar, minimizar (libera o espaço e volta a ser um agente minimizado na doca) e fechar (some até o usuário reabri-lo).
- O ícone **Agentes** na topbar lista as conversas, para continuar uma anterior ou iniciar uma nova.
