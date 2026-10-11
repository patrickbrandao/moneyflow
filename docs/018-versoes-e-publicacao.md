# 018 — Versões e publicação

## Versões

- A série atual é **0.1.x**: a primeira publicação é `v0.1.0`, e cada nova release incrementa o último número (`v0.1.1`, `v0.1.2`…). Mudar o número do meio ou chegar à `1.0.0` é decisão do dono do produto.
- A versão fica em `package.json` (raiz) e é a fonte do `make release`. A tag git `vX.Y.Z` aponta para o commit publicado.
- Cada release publica `tmsoftbrasil/moneyflow:X.Y.Z` e move `:latest` para ela (amd64 + arm64).

## Como publicar

- **Desta máquina** (padrão hoje): atualizar a versão em `package.json`, commitar, criar a tag `vX.Y.Z`, rodar `make release` com a conta `tmsoftbrasil` logada no Docker e fazer push do commit e da tag.
- **Pelo CI**: `release.yml` faz o mesmo numa tag `v*`, mas só publica se os secrets `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN` existirem no repositório.

## Ambientes

- Este repositório roda **só em Docker local** (desenvolvimento, testes e validação).
- O setup do serviço e a publicação em produção (servidor, domínio, HTTPS, backup) ficam num **projeto externo**, que consome a imagem do Docker Hub. Este repositório não contém scripts de deploy de produção.

## Validação da série 0.1.x

O usuário valida por uso livre numa base limpa. Achados e pedidos viram tarefas em `tasks/` ([017](017-tarefas-entre-agentes.md)); cada lote corrigido pode virar uma nova release 0.1.x.
