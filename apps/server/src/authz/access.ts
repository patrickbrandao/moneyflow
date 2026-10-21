import { caixaMembers, caixas, type Executor } from '@moneyflow/db';
import { type CaixaRole, type EffectiveRole, type GlobalRole, t } from '@moneyflow/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { forbidden, notFound } from '../errors';

/*
 * Camada única de autorização (spec 002). Admin global vê e escreve em tudo;
 * os demais só enxergam as caixas em caixa_members (editor = escrita,
 * viewer = leitura). Quem acessa a caixa pagadora padrão de um cartão
 * enxerga a caixa do cartão (leitura).
 *
 * Serviços e, na F4, as tools dos agentes recebem um `Access` e chamam
 * assertRead/assertWrite — nunca consultam caixa_members por conta própria.
 * Anotações (spec 035) não são da caixa: assertReadNote/assertWriteNote
 * (o admin vê e edita todas; os demais veem as próprias e as globais e
 * editam só as próprias).
 */

/** O que decide a visibilidade e a edição de uma anotação (spec 035). */
export type NoteOwnership = { authorId: string; scope: 'private' | 'global' };

export type Actor = { id: string; username: string; email: string; role: GlobalRole; isActive: boolean };

export class Access {
  constructor(
    readonly actor: Actor,
    private readonly roles: Map<string, CaixaRole>,
  ) {}

  get isAdmin() {
    return this.actor.role === 'admin';
  }

  /** Papel efetivo na caixa, ou null sem acesso. */
  roleIn(caixaId: string): EffectiveRole | null {
    if (this.isAdmin) return 'admin';
    return this.roles.get(caixaId) ?? null;
  }

  canRead(caixaId: string) {
    return this.roleIn(caixaId) !== null;
  }

  canWrite(caixaId: string) {
    const role = this.roleIn(caixaId);
    return role === 'admin' || role === 'editor';
  }

  /** Sem leitura, a caixa "não existe" para o usuário (404, não 403). */
  assertRead(caixaId: string) {
    if (!this.canRead(caixaId)) throw notFound();
  }

  assertWrite(caixaId: string) {
    this.assertRead(caixaId);
    if (!this.canWrite(caixaId)) throw forbidden(t.errors.readOnly);
  }

  assertAdmin() {
    if (!this.isAdmin) throw forbidden();
  }

  /** Cadastros globais (entidades, caixas novas): admin ou editor de alguma caixa. */
  get canEditRegistry() {
    return this.isAdmin || [...this.roles.values()].includes('editor');
  }

  assertRegistryWrite() {
    if (!this.canEditRegistry) throw forbidden();
  }

  /** Caixas legíveis: 'all' para admin. */
  readableCaixaIds(): string[] | 'all' {
    return this.isAdmin ? 'all' : [...this.roles.keys()];
  }

  /** Registra um papel concedido durante a própria requisição (ex.: quem cria a caixa vira editor). */
  grant(caixaId: string, role: CaixaRole) {
    this.roles.set(caixaId, role);
  }

  /* ---------------- anotações (spec 035) ---------------- */

  /** Lê a anotação: o admin, todas; os demais, as próprias e as globais. */
  canReadNote(note: NoteOwnership) {
    return this.isAdmin || note.authorId === this.actor.id || note.scope === 'global';
  }

  /** Edita (e arquiva) a anotação: só o autor e o admin. */
  canWriteNote(note: NoteOwnership) {
    return this.isAdmin || note.authorId === this.actor.id;
  }

  /** Sem leitura, a anotação "não existe" (404). */
  assertReadNote(note: NoteOwnership) {
    if (!this.canReadNote(note)) throw notFound(t.notes.errors.notFound);
  }

  /** A global de outro autor é somente leitura (403). */
  assertWriteNote(note: NoteOwnership) {
    this.assertReadNote(note);
    if (!this.canWriteNote(note)) throw forbidden(t.notes.errors.readOnly);
  }

  /** Parâmetro de visibilidade das funções do banco (note_occurrences, note_calendar): nulo = todas (admin). */
  noteVisibleTo(): string | null {
    return this.isAdmin ? null : this.actor.id;
  }

  writableCaixaIds(): string[] | 'all' {
    return this.isAdmin ? 'all' : [...this.roles].filter(([, role]) => role === 'editor').map(([id]) => id);
  }
}

export async function loadAccess(db: Executor, actor: Actor): Promise<Access> {
  const roles = new Map<string, CaixaRole>();
  if (actor.role !== 'admin') {
    const rows = await db
      .select({ caixaId: caixaMembers.caixaId, role: caixaMembers.role })
      .from(caixaMembers)
      .where(eq(caixaMembers.userId, actor.id));
    for (const row of rows) roles.set(row.caixaId, row.role as CaixaRole);
    // Cartões cuja pagadora padrão o usuário acessa: leitura (spec 002/007).
    const payerIds = [...roles.keys()];
    if (payerIds.length > 0) {
      const cards = await db
        .select({ id: caixas.id })
        .from(caixas)
        .where(and(eq(caixas.kind, 'credit_card'), inArray(caixas.defaultPayerCaixaId, payerIds), isNull(caixas.archivedAt)));
      for (const card of cards) if (!roles.has(card.id)) roles.set(card.id, 'viewer');
    }
  }
  return new Access(actor, roles);
}
