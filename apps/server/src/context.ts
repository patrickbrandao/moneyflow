import type { Database } from '@moneyflow/db';
import type { Access } from './authz/access';
import type { Config } from './config';

/**
 * Contexto dos serviços de domínio: banco, quem age e o que pode. As rotas
 * HTTP montam um por requisição; as tools dos agentes (F4) montarão o mesmo.
 */
export type ServiceContext = {
  db: Database;
  access: Access;
  config: Config;
};
