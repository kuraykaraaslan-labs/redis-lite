import { FlowProducer, Queue, QueueEvents, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisLite } from '../src/index';

let server: RedisLite;
const closers: Array<() => Promise<unknown>> = [];

function connection() {
  return new Redis(server.url, { maxRetriesPerRequest: null });
}

function track<T extends { close(): Promise<unknown> }>(x: T): T {
  closers.push(() => x.close());
  return x;
}

let n = 0;
const qname = () => `q${++n}`;

beforeAll(async () => {
  server = await RedisLite.start({ port: 0 });
});

afterAll(async () => {
  for (const close of closers.reverse()) await close().catch(() => undefined);
  await server.close();
});

function waitFor<T>(fn: (resolve: (v: T) => void) => void, ms = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

describe('BullMQ on redis-lite', () => {
  it('processes jobs and reports counts', async () => {
    const name = qname();
    const queue = track(new Queue(name, { connection: connection() }));
    const done: string[] = [];
    const finished = waitFor<void>((resolve) => {
      const worker = track(new Worker(name, async (job: Job) => {
        done.push(job.data.v);
        return job.data.v.toUpperCase();
      }, { connection: connection() }));
      worker.on('completed', () => done.length === 3 && resolve());
    });
    await queue.add('t', { v: 'a' });
    await queue.addBulk([{ name: 't', data: { v: 'b' } }, { name: 't', data: { v: 'ç' } }]);
    await finished;
    expect(done.sort()).toEqual(['a', 'b', 'ç']);
    const counts = await queue.getJobCounts('completed', 'waiting', 'active', 'failed');
    expect(counts).toMatchObject({ completed: 3, waiting: 0, active: 0, failed: 0 });
    const [job] = await queue.getCompleted(0, 0);
    expect(['A', 'B', 'Ç']).toContain(job.returnvalue);
  });

  it('delayed jobs, priorities and retries with backoff', async () => {
    const name = qname();
    const queue = track(new Queue(name, { connection: connection() }));
    const order: string[] = [];
    let attempts = 0;
    const started = Date.now();
    const finished = waitFor<number>((resolve) => {
      track(new Worker(name, async (job: Job) => {
        if (job.name === 'flaky') {
          attempts++;
          if (attempts < 3) throw new Error('boom');
          return;
        }
        order.push(job.name);
        if (job.name === 'delayed') resolve(Date.now() - started);
      }, { connection: connection(), autorun: true }));
    });
    await queue.add('delayed', {}, { delay: 400 });
    await queue.add('flaky', {}, { attempts: 3, backoff: { type: 'fixed', delay: 50 } });
    const elapsed = await finished;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(attempts).toBe(3);
  });

  it('priority order', async () => {
    const name = qname();
    const queue = track(new Queue(name, { connection: connection() }));
    await queue.add('low', {}, { priority: 10 });
    await queue.add('high', {}, { priority: 1 });
    await queue.add('mid', {}, { priority: 5 });
    const order: string[] = [];
    await waitFor<void>((resolve) => {
      track(new Worker(name, async (job: Job) => {
        order.push(job.name);
        if (order.length === 3) resolve();
      }, { connection: connection(), concurrency: 1 }));
    });
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('QueueEvents sees completed and failed', async () => {
    const name = qname();
    const events = track(new QueueEvents(name, { connection: connection() }));
    await events.waitUntilReady();
    const queue = track(new Queue(name, { connection: connection() }));
    track(new Worker(name, async (job: Job) => {
      if (job.data.fail) throw new Error('nope');
      return 42;
    }, { connection: connection() }));
    const ok = await queue.add('ok', {});
    const bad = await queue.add('bad', { fail: true });
    expect(await ok.waitUntilFinished(events, 5000)).toBe(42);
    await expect(bad.waitUntilFinished(events, 5000)).rejects.toThrow('nope');
  });

  it('flows: parent runs after children', async () => {
    const name = qname();
    const flow = track(new FlowProducer({ connection: connection() }));
    const result = waitFor<Record<string, unknown>>((resolve) => {
      track(new Worker(name, async (job: Job) => {
        if (job.name === 'parent') {
          const values = await job.getChildrenValues();
          resolve(values);
          return 'p';
        }
        return job.data.x * 2;
      }, { connection: connection() }));
    });
    await flow.add({ name: 'parent', queueName: name, children: [
      { name: 'c', queueName: name, data: { x: 1 } },
      { name: 'c', queueName: name, data: { x: 2 } },
    ] });
    expect(Object.values(await result).sort()).toEqual([2, 4]);
  });

  it('job schedulers (repeat)', async () => {
    const name = qname();
    const queue = track(new Queue(name, { connection: connection() }));
    let runs = 0;
    await queue.upsertJobScheduler('tick', { every: 150 }, { name: 'tick', data: {} });
    await waitFor<void>((resolve) => {
      track(new Worker(name, async () => {
        runs++;
        if (runs === 3) resolve();
      }, { connection: connection() }));
    });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers[0]?.key ?? schedulers[0]?.id).toBe('tick');
    await queue.removeJobScheduler('tick');
    expect(runs).toBeGreaterThanOrEqual(3);
  });

  it('rate limiter, pause/resume, workers list, obliterate', async () => {
    const name = qname();
    const queue = track(new Queue(name, { connection: connection() }));
    const times: number[] = [];
    const worker = track(new Worker(name, async () => {
      times.push(Date.now());
    }, { connection: connection(), limiter: { max: 1, duration: 200 }, name: 'w1' }));
    await worker.waitUntilReady();
    await queue.pause();
    await queue.add('a', {});
    await queue.add('b', {});
    expect(await queue.isPaused()).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(times.length).toBe(0);
    await queue.resume();
    await waitFor<void>((resolve) => {
      const t = setInterval(() => times.length === 2 && (clearInterval(t), resolve()), 20);
    });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(150);
    const workers = await queue.getWorkers();
    expect(workers.length).toBeGreaterThanOrEqual(1);
    await worker.close();
    await queue.obliterate({ force: true });
    const counts = await queue.getJobCounts();
    expect(Object.values(counts).every((c) => c === 0)).toBe(true);
  });

  it('progress, logs, removeOnComplete, getJob', async () => {
    const name = qname();
    const queue = track(new Queue(name, { connection: connection() }));
    const job = await queue.add('p', { a: 1 }, { removeOnComplete: true, jobId: 'custom-1' });
    expect((await queue.getJob('custom-1'))?.data).toEqual({ a: 1 });
    await waitFor<void>((resolve) => {
      const w = track(new Worker(name, async (j: Job) => {
        await j.updateProgress(50);
        await j.log('half');
      }, { connection: connection() }));
      w.on('completed', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await queue.getJob(job.id as string)).toBeUndefined();
  });
});
