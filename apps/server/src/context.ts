import type { Database } from '@moneyflow/db';
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
};
