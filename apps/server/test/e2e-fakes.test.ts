import { describe, expect, it } from 'vitest';
import { startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { startFakeTelegram } from '../../../e2e/fakes/fake-telegram';

/* Os falsos dos e2e e da integração com a porta já ocupada (tarefa 125): erro claro, não uma exceção solta. */

describe('falsos dos e2e com a porta ocupada', () => {
  it('o provedor de IA falso recusa com a mensagem da porta', async () => {
    const first = await startFakeLlm(0, '127.0.0.1');
    try {
      await expect(startFakeLlm(first.port, '127.0.0.1')).rejects.toThrow(`a porta ${first.port} está ocupada`);
    } finally {
      await first.close();
    }
  });

  it('a Bot API falsa recusa com a mensagem da porta', async () => {
    const first = await startFakeTelegram(0, '127.0.0.1');
    try {
      await expect(startFakeTelegram(first.port, '127.0.0.1')).rejects.toThrow(`a porta ${first.port} está ocupada`);
    } finally {
      await first.close();
    }
  });
});
