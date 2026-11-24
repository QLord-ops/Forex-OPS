export class TimeLimitError extends Error {
  constructor(readonly ms: number) {
    super(`timeout ${ms} ms`);
    this.name = "TimeLimitError";
  }
}

/** The work's answer, or TimeLimitError after `ms`. The work itself is not cancelled: the caller just stops waiting. */
export async function withTimeLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new TimeLimitError(ms)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
