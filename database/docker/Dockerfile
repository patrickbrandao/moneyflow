# PostgreSQL 18 + pgvector (imagem oficial do pgvector) + pgTAP para testes.
# Versões fixas (tarefa 163, docs/016 "Motor e imagem"): PostgreSQL 18.7 e pgvector 0.8.7 no Debian bookworm, pela tag e
# pelo digest da imagem; pgTAP 1.3.4 e pg_prove 3.37 do apt do PGDG. Para atualizar, troque a tag e o digest juntos
# (docker buildx imagetools inspect pgvector/pgvector:<tag>) e as versões do apt (apt-cache policy dentro da imagem),
# rode o make test inteiro e registre as versões novas na docs/016.
FROM pgvector/pgvector:0.8.7-pg18-bookworm@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-18-pgtap=1.3.4-1.pgdg12+2 \
      libtap-parser-sourcehandler-pgtap-perl=3.37-1.pgdg120+1 \
 && rm -rf /var/lib/apt/lists/*

COPY docker/initdb/ /docker-entrypoint-initdb.d/
