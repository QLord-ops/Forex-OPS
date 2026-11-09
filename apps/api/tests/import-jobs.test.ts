import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ImportJobError, ImportJobs } from '../src/services/import-jobs.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('reading an Auftrag as a background job', () => {
  it('answers at once when the reading is quick, keeps going when it is slow, and hands the result to its owner only', async () => {
    const jobs = new ImportJobs();
    const quick = jobs.start('anna', async () => 'done quickly');
    expect(await quick.settled(1000)).toMatchObject({ status: 'done', result: 'done quickly' });

    const finished = vi.fn();
    const slow = jobs.start('anna', async () => { await sleep(150); return { drafts: 1 }; }, finished);
    expect(await slow.settled(20)).toMatchObject({ status: 'running' });
    expect(jobs.running).toBe(1);
    expect(jobs.get(slow.id, 'anna')).toMatchObject({ status: 'running' });
    expect(jobs.get(slow.id, 'boris')).toBeNull();
    expect(jobs.get('no-such-job', 'anna')).toBeNull();
    await sleep(200);
    expect(jobs.get(slow.id, 'anna')).toMatchObject({ status: 'done', result: { drafts: 1 } });
    expect(finished).toHaveBeenCalledTimes(1);
    expect(jobs.running).toBe(0);
  });

  it('keeps the message written for the dispatcher and hides anything else behind a plain failure', async () => {
    const jobs = new ImportJobs();
    const own = jobs.start('anna', async () => { throw new ImportJobError('OpenAI ещё не настроен для импорта PDF.', 503); });
    expect(await own.settled(100)).toMatchObject({ status: 'failed', statusCode: 503, error: 'OpenAI ещё не настроен для импорта PDF.' });
    const raw = jobs.start('anna', async () => { throw new Error('ECONNRESET api.openai.com secret-token'); });
    const state = await raw.settled(100);
    expect(state).toMatchObject({ status: 'failed', statusCode: 502 });
    expect(JSON.stringify(state)).not.toContain('secret-token');
  });

  it('forgets a finished job after its keep time', async () => {
    const jobs = new ImportJobs(30);
    const job = jobs.start('anna', async () => 1);
    await job.settled(100);
    expect(jobs.get(job.id, 'anna')).toMatchObject({ status: 'done' });
    await sleep(60);
    expect(jobs.get(job.id, 'anna')).toBeNull();
  });
});

describe('POST /imports/pdf/preview with a slow AI', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterAll(async () => { await Promise.all(apps.map((app) => app.close())); });

  const preview = {
    source: 'OPENAI' as const, detectedLayout: 'PDF' as const, aiAvailable: true as const, usedAi: true as const, warnings: [],
    drafts: [{ orderNumber: 'PDF-SLOW', vehicleNumber: '936', warnings: [], stops: [
      { sequence: 1, type: 'LOAD' as const, company: null, address: 'Alexanderplatz 1, 10178 Berlin', city: 'Berlin', appointmentLocal: null, sourcePage: 1, confidence: 0.9 },
      { sequence: 2, type: 'UNLOAD' as const, company: null, address: 'Am Sandtorkai 1, 20457 Hamburg', city: 'Hamburg', appointmentLocal: null, sourcePage: 1, confidence: 0.9 }
    ] }]
  };
  function multipart(filename: string, content: Buffer, mimeType: string) {
    const boundary = 'ops-boundary';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([head, content, tail]) };
  }
  const pdf = multipart('auftrag.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'), 'application/pdf');

  it('answers 202 with a job while the AI is still reading; the page collects the preview later', async () => {
    const pdfImport = vi.fn(async () => { await sleep(250); return preview; });
    const app = await buildApp({ pdfImport, auth: { disabled: true }, importWaitMs: 30 });
    apps.push(app);
    const upload = await app.inject({ method: 'POST', url: '/imports/pdf/preview', ...pdf });
    expect(upload.statusCode).toBe(202);
    const { jobId } = upload.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    const early = await app.inject({ method: 'GET', url: `/imports/jobs/${jobId}` });
    expect(early.statusCode).toBe(202);
    expect(early.json()).toMatchObject({ status: 'running' });
    await sleep(400);
    const late = await app.inject({ method: 'GET', url: `/imports/jobs/${jobId}` });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({ status: 'done', preview: { drafts: [{ orderNumber: 'PDF-SLOW' }] } });

    // The slot of the slow reading is free again for the next upload.
    const next = await app.inject({ method: 'POST', url: '/imports/pdf/preview', ...pdf });
    expect([200, 202]).toContain(next.statusCode);
    expect((await app.inject({ method: 'GET', url: '/imports/jobs/unknown' })).statusCode).toBe(404);
  });

  it('a failed reading reaches the page with the API’s own message', async () => {
    const pdfImport = vi.fn(async () => { await sleep(100); throw new Error('AbortError'); });
    const app = await buildApp({ pdfImport, auth: { disabled: true }, importWaitMs: 10 });
    apps.push(app);
    const upload = await app.inject({ method: 'POST', url: '/imports/pdf/preview', ...pdf });
    expect(upload.statusCode).toBe(202);
    await sleep(200);
    const result = await app.inject({ method: 'GET', url: `/imports/jobs/${(upload.json() as { jobId: string }).jobId}` });
    expect(result.statusCode).toBe(502);
    expect(result.json()).toEqual({ error: 'Не удалось прочитать PDF-заказ. Проверьте файл и повторите попытку.' });
  });
});
