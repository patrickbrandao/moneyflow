import type { Database } from '@moneyflow/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Access } from './authz/access';
import type { Config } from './config';

/**
 * Contexto dos serviços de domínio: banco, quem age e o que pode. As rotas
 * HTTP montam um por requisição; as tools dos agentes (F4) montarão o mesmo
 * com actorKind = 'agent' e o agentRunId da execução (auditoria, docs/016).
 */
export type ServiceContext = {
  db: Database;
  access: Access;
  config: Config;
  /** Quem age nas escritas (padrão human). */
  actorKind?: 'human' | 'agent';
  agentRunId?: string | null;
  /**
   * Execução de uma receita de conciliação (spec 030): as linhas do extrato no
   * escopo. As tools de conciliação recusam qualquer linha fora dele.
   */
  recipeLineIds?: ReadonlySet<string> | null;
  /**
   * Sessão do console que fez a requisição (id = sha256 do token), quando houver. Trocar a
   * própria senha encerra as outras sessões e mantém esta (tarefa 067); sem ela (/mcp, worker),
   * todas as sessões do usuário são encerradas.
   */
  sessionId?: string | null;
  /**
   * Logger de quem montou o contexto (a requisição, o /mcp ou o worker). As tools registram por ele os
   * erros que viram mensagem segura para o modelo (tarefa 099), e os serviços, as falhas que contornam sem
   * erro (a baixa automática que vira sugestão, tarefa 136), sem dados da linha. Sem ele, nada é registrado.
   */
  log?: FastifyBaseLogger;
};
