/*
 * Parada com prazo (tarefa 107): espera o trabalho em andamento até `ms` e
 * segue mesmo que ele não termine (a reserva vencida retoma o que ficou).
 */

/** Espera as promessas terminarem (cumpridas ou não) até `ms`; true se todas terminaram no prazo. */
export async function settleWithin(promises: Iterable<Promise<unknown>>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.allSettled([...promises]).then(() => true as const), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Guarda a promessa enquanto ela roda (o conjunto é o que a parada espera). */
export function tracked<T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  set.add(promise);
  const done = () => {
    set.delete(promise);
  };
  promise.then(done, done);
  return promise;
}
