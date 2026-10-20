import { z } from 'zod';
import { id } from '../schemas/common';
import { supersedeResolveItem } from '../schemas/operation';
import { define } from './tool-def';

/*
 * Tools do lote provisório e da troca pelo consolidado (spec 031, categoria
 * Conciliação). Não entram sozinhas em kit nenhum; ficam no /mcp.
 */
export const SUPERSEDE_TOOLS = [
  define({
    name: 'set_statement_import_provisional',
    category: 'reconciliation',
    title: 'Marcar lote como provisório',
    description:
      'Marca (provisional true) ou desmarca um lote de extrato de conta como provisório: extrato parcial do mês, fora da deduplicação e na divergência só até ser substituído pelo consolidado (supersede_statement_import). Lote já substituído não muda.',
    kind: 'write',
    input: z.object({ importId: id, provisional: z.boolean() }),
  }),
  define({
    name: 'supersede_statement_import',
    category: 'reconciliation',
    title: 'Substituir o provisório pelo consolidado',
    description:
      'A partir do lote consolidado (importId), substitui os lotes provisórios da conta (provisionalImportIds; omitidos = os ativos sobrepostos ao período dele) numa transação: casa as linhas por data e valor únicos (desempate pela descrição idêntica), passa as conciliações para as linhas do consolidado com os MESMOS lançamentos (nada é excluído nem lançado de novo) e devolve as transferidas, as casadas, as descartadas, as sobras pendentes do provisório (conciliadas sem par: decida com resolve_superseded_lines) e as linhas do consolidado sem par (seguem a conciliação normal). A prévia é a troca sem gravar.',
    kind: 'write',
    input: z.object({ importId: id, provisionalImportIds: z.array(id).min(1).max(20).optional() }),
  }),
  define({
    name: 'resolve_superseded_lines',
    category: 'reconciliation',
    title: 'Decidir as sobras do provisório',
    description:
      'Decide as sobras pendentes dos provisórios substituídos pelo lote importId (linhas com supersedeOutcome pending em get_statement_import do provisório): pair casa com uma linha do consolidado sem par, de mesmo valor e não conciliada (consolidatedLineId; a conciliação passa sem relançar); keep solta a linha e mantém o lançamento; delete_entry exclui o lançamento que nasceu da linha (createdEntry). Até 500 itens, cada um independente: os que falham voltam em failed.',
    kind: 'write',
    destructive: true,
    input: z.object({ importId: id, items: z.array(supersedeResolveItem).min(1).max(500) }),
  }),
] as const;
