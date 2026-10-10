# PostgreSQL 18 + pgvector (imagem oficial do pgvector) + pgTAP para testes.
FROM pgvector/pgvector:pg18

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-18-pgtap libtap-parser-sourcehandler-pgtap-perl \
 && rm -rf /var/lib/apt/lists/*

COPY docker/initdb/ /docker-entrypoint-initdb.d/
