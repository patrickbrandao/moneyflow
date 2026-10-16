import { describe, expect, it } from 'vitest';
import {
  aiAgentCreateInput,
  aiAgentUpdateInput,
  renderPromptVariables,
  renderRecipeVariables,
  scanPromptVariables,
  scanRecipeVariables,
  volatilePromptValues,
} from '../src';

/* Variáveis no prompt do agente (spec 022). */

describe('variáveis do prompt', () => {
  it('acha as usadas, as desconhecidas e se alguma é volátil; o escape \\{{ não conta', () => {
    expect(scanPromptVariables('Olá {{usuario.nome}} e {{ agente.nome }}; {{usuario.nome}} de novo')).toEqual({
      used: ['usuario.nome', 'agente.nome'],
      unknown: [],
      volatile: false,
    });
    expect(scanPromptVariables('Hoje é {{data}} ({{dia_semana}}), {{nada}} e {{usuario.cpf}}')).toEqual({
      used: ['data', 'dia_semana'],
      unknown: ['nada', 'usuario.cpf'],
      volatile: true,
    });
    expect(scanPromptVariables('JSON literal: \\{{nada}} e chave solta {{ sem fim')).toEqual({ used: [], unknown: [], volatile: false });
  });

  it('substitui (ausente = vazio), desfaz o escape e deixa as desconhecidas', () => {
    const text = 'Sou {{agente.nome}} para {{usuario.nome}} ({{usuario.caixa_principal}}). Literal: \\{{data}}. {{x}}';
    expect(renderPromptVariables(text, { 'agente.nome': 'Ana', 'usuario.nome': 'joao', data: '01/01/2030' })).toBe(
      'Sou Ana para joao (). Literal: {{data}}. {{x}}',
    );
  });

  it('valores voláteis em pt-BR', () => {
    expect(volatilePromptValues('2026-10-14')).toEqual({
      data: '14/10/2026',
      data_iso: '2026-10-14',
      dia_semana: 'quarta-feira',
      mes_ano: 'outubro de 2026',
    });
  });

  it('o agente com variável desconhecida é recusado ao salvar, com o nome', () => {
    const created = aiAgentCreateInput.safeParse({ name: 'A', systemPrompt: 'Use {{usuario.cpf}}' });
    expect(created.success).toBe(false);
    expect(created.error?.issues[0]?.message).toContain('{{usuario.cpf}}');
    expect(aiAgentUpdateInput.safeParse({ systemPrompt: 'Oi {{usuario.nome}} \\{{livre}}' }).success).toBe(true);
  });

  it('receitas (spec 030): as variáveis do lote valem só na instrução da receita', () => {
    expect(scanPromptVariables('{{lote.arquivo}}').unknown).toEqual(['lote.arquivo']);
    expect(scanRecipeVariables('{{lote.arquivo}} {{linhas.total}} {{data}}').unknown).toEqual([]);
    expect(renderRecipeVariables('{{lote.arquivo}}: {{linhas.total}} {{x}}', { 'lote.arquivo': 'a.ofx', 'linhas.total': '3' })).toBe(
      'a.ofx: 3 {{x}}',
    );
  });
});
