-- migrate:up

-- Agente dos fluxos automáticos (tarefa 002; spec 011): o admin marca no máximo um agente para atender a leitura de
-- documento, as sugestões da conciliação, a leitura do PDF do contrato e o PDF → markdown. Substitui a variável
-- AI_FLOW_AGENT. Sem agente marcado, a aplicação decide (hoje: o primeiro agente ativo).
--
-- O marcado precisa estar ativo e não arquivado (CHECK, não trigger que desmarca sozinho): desativar ou arquivar o
-- agente marcado é recusado (23514) até desmarcá-lo, o que a aplicação faz na mesma transação. Assim a troca é
-- sempre explícita e aparece na auditoria de ai_agents.

ALTER TABLE ai_agents ADD COLUMN use_for_flows boolean NOT NULL DEFAULT false;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_use_for_flows_check CHECK (
  NOT use_for_flows OR (is_active AND archived_at IS NULL)
);

-- No máximo um marcado.
CREATE UNIQUE INDEX ai_agents_use_for_flows_key ON ai_agents ((true)) WHERE use_for_flows;

COMMENT ON COLUMN ai_agents.use_for_flows IS
  'true = agente que atende os fluxos automáticos (leitura de documento, sugestões da conciliação, leitura do PDF do '
  'contrato e PDF → markdown). No máximo um (ai_agents_use_for_flows_key, 23505) e só ativo e não arquivado '
  '(ai_agents_use_for_flows_check, 23514: desmarque antes de desativar ou arquivar). Nenhum marcado = a aplicação '
  'escolhe (primeiro agente ativo).';

-- migrate:down

DROP INDEX ai_agents_use_for_flows_key;
ALTER TABLE ai_agents DROP COLUMN use_for_flows;
