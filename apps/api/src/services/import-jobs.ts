import { randomUUID } from 'node:crypto';

/**
 * Reading an Auftrag with the AI can take minutes, longer than any proxy in front of the API waits (Vercel: 120 s).
 * The upload therefore starts a job and answers at once when the job is still running; the page then asks for the
 * result until it is there. Jobs live in memory of the one API instance and belong to the session that started them.
 */
export type ImportJobState<T = unknown> =
  | { status: 'running'; startedAt: number }
  | { status: 'done'; startedAt: number; result: T }
  | { status: 'failed'; startedAt: number; statusCode: number; error: string };

/** A failure the dispatcher may see: the status and the message are the API's own, never a provider's text. */
export class ImportJobError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'ImportJobError';
  }
}

export type ImportJobHandle<T> = {
  id: string;
  /** The state once the job finished, or `running` when it is still at work after `waitMs`. */
  settled: (waitMs: number) => Promise<ImportJobState<T>>;
};

type Job = { owner: string; state: ImportJobState; done: Promise<void> };

export class ImportJobs {
  private readonly jobs = new Map<string, Job>();

  /** Finished jobs stay this long for the page to collect them; a page that never asks does not pile them up. */
  constructor(private readonly keepMs = 15 * 60_000, private readonly now: () => number = Date.now) {}

  start<T>(owner: string, run: () => Promise<T>, onFinish?: () => void): ImportJobHandle<T> {
    const id = randomUUID();
    const job: Job = { owner, state: { status: 'running', startedAt: this.now() }, done: Promise.resolve() };
    job.done = run()
      .then((result) => { job.state = { status: 'done', startedAt: job.state.startedAt, result }; })
      .catch((error: unknown) => {
        // Only errors written for the dispatcher (own status and message) reach the page; anything else is a plain failure.
        const own = error instanceof Error && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? error as Error & { statusCode: number } : null;
        job.state = own
          ? { status: 'failed', startedAt: job.state.startedAt, statusCode: own.statusCode, error: own.message }
          : { status: 'failed', startedAt: job.state.startedAt, statusCode: 502, error: 'Не удалось прочитать Auftrag. Проверьте файл и повторите попытку.' };
      })
      .finally(() => {
        onFinish?.();
        setTimeout(() => this.jobs.delete(id), this.keepMs).unref?.();
      });
    this.jobs.set(id, job);
    return {
      id,
      settled: async (waitMs) => {
        await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())]);
        return job.state as ImportJobState<T>;
      }
    };
  }

  /** The job's state for its owner; another session, or an id already forgotten, gets nothing. */
  get(id: string, owner: string): ImportJobState | null {
    const job = this.jobs.get(id);
    return job && job.owner === owner ? job.state : null;
  }

  get running() {
    return [...this.jobs.values()].filter((job) => job.state.status === 'running').length;
  }
}

/**
 * How many readings run at once and how many wait their turn. Five dispatchers upload their Auftrag in the same
 * minutes of the morning: the third one waits for a free place instead of being told to try again later.
 */
export class ImportSlots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max = 2, private readonly maxWaiting = 8) {}

  /** A place in line, or null when the line itself is full. `ready` resolves when the reading may start; `leave` frees the place. */
  enter(): { ready: Promise<void>; leave: () => void } | null {
    let started = false, left = false;
    let start: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { start = () => { started = true; this.running += 1; resolve(); }; });
    if (this.running < this.max) start();
    else if (this.waiting.length >= this.maxWaiting) return null;
    else this.waiting.push(start);
    return {
      ready,
      leave: () => {
        if (left) return;
        left = true;
        if (!started) { this.waiting.splice(this.waiting.indexOf(start), 1); return; }
        this.running -= 1;
        this.waiting.shift()?.();
      }
    };
  }

  get queued() { return this.waiting.length; }
  get active() { return this.running; }
}
