import { appendFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisLite } from '@/index';
import { tempDir } from '@/tests/helpers';

import { DiffConnection } from './differential.connection';
import type { Normalizer } from './differential.normalizers';
import { Oracle, oracleBinary } from './differential.oracle';
import { parseResp, payload, show, tokenize } from './differential.resp';

/**
 * Differential harness: every scenario runs the same command sequence against a fresh redis-lite and against the
 * oracle (a real redis-server, reset between scenarios) and compares the raw reply bytes, once over RESP2 and once
 * over RESP3 (HELLO 3 first). See docs/DIFFERENTIAL.md.
 *
 *   differential('strings', [
 *     s('SET then GET', ['SET k v', 'GET k']),
 *     s('random pick', [{ cmd: 'SRANDMEMBER s 2', norm: shape }]),
 *   ]);
 */

/** A mismatch caused by the oracle's version (7.0) vs redis-lite's target (8.x): the test is expected to fail. */
export interface KnownDiff {
  /** What changed after 7.0 and in which version. */
  why: string;
  confidence: 'high' | 'medium' | 'low';
  /** Only this protocol differs (the other one is a normal test). */
  proto?: 2 | 3;
}

export interface StepObject {
  /** A command line (redis-cli quoting, see `tokenize`) or an argv. */
  cmd?: string | string[];
  /** Connection index (0 by default); connections open on first use. */
  c?: number;
  /** false: send without reading the reply (a blocking command); read it later with `{ c, read: 1 }`. */
  wait?: boolean;
  /** Number of replies the command produces (default 1, or the channel count of (UN)SUBSCRIBE). */
  replies?: number;
  /** Reads this many replies on connection `c` without sending anything. */
  read?: number;
  /** Waits until this many clients are blocked on each server. */
  blocked?: number;
  /** Sleeps this many ms (expiry; both servers run in parallel, so it costs the time once). */
  sleep?: number;
  /** Runs a whole SCAN / SSCAN / HSCAN / ZSCAN iteration (cursor 0 in the line); compares the sorted element set. */
  scan?: string;
  /** Normaliser of this step's reply (overrides the scenario's). */
  norm?: Normalizer;
  /** Read timeout in ms (default 3000). */
  timeout?: number;
}

export type Step = string | StepObject;

export interface Scenario {
  name: string;
  steps: Step[];
  /** Normaliser applied to every step without its own. */
  norm?: Normalizer;
  /** Run only over this protocol. */
  proto?: 2 | 3;
  /** Expected to differ because of the version gap (the test is `it.fails`). */
  diff?: KnownDiff;
  /** Restart the oracle after the scenario (it changes state FLUSHALL / CONFIG cannot restore: DEBUG, ACL…). */
  fresh?: boolean;
  /** Per-test timeout in ms for slow scenarios (default: the vitest testTimeout). */
  testTimeout?: number;
}

export type ScenarioOptions = Omit<Scenario, 'name' | 'steps'>;

export function s(name: string, steps: Step[], options: ScenarioOptions = {}): Scenario {
  return { name, steps, ...options };
}

/** Marks a scenario as a version difference. */
export function v(why: string, confidence: KnownDiff['confidence'] = 'high', proto?: 2 | 3): { diff: KnownDiff } {
  return { diff: { why, confidence, proto } };
}

/** One recorded step: what was sent and the (normalised) reply bytes. */
export interface Entry {
  label: string;
  reply: string;
}

const SUBSCRIBE = /^(p|s)?(un)?subscribe$/i;
const READ_TIMEOUT = 3_000;

function argv(cmd: string | string[]): string[] {
  return Array.isArray(cmd) ? cmd : tokenize(cmd);
}

function replyCount(args: string[], step: StepObject): number {
  if (step.replies !== undefined) return step.replies;
  if (SUBSCRIBE.test(args[0] ?? '')) return Math.max(1, args.length - 1);
  return 1;
}

/** Opens a connection, switched to RESP3 when asked (the HELLO reply carries a version and an id: not recorded). */
async function openConnection(port: number, proto: 2 | 3): Promise<DiffConnection> {
  const c = await DiffConnection.open(port);
  if (proto === 3) await c.call(['HELLO', '3']);
  return c;
}

async function blockedClients(c: DiffConnection): Promise<number> {
  const info = parseResp(await c.call(['INFO', 'clients'])).node;
  return Number(/blocked_clients:(\d+)/.exec(payload(info))?.[1] ?? 0);
}

/** Runs one scenario against the server on `port` and returns its transcript. */
export async function execute(port: number, scenario: Scenario, proto: 2 | 3): Promise<Entry[]> {
  const conns = new Map<number, DiffConnection>();
  const conn = async (i: number): Promise<DiffConnection> => {
    let c = conns.get(i);
    if (!c) {
      c = await openConnection(port, proto);
      conns.set(i, c);
    }
    return c;
  };
  const out: Entry[] = [];
  try {
    for (const raw of scenario.steps) {
      const step: StepObject = typeof raw === 'string' ? { cmd: raw } : raw;
      const ci = step.c ?? 0;
      const tag = ci === 0 ? '' : `c${ci} `;
      const norm = step.norm ?? scenario.norm ?? ((r: string) => r);
      const timeout = step.timeout ?? READ_TIMEOUT;
      if (step.sleep !== undefined) {
        await new Promise((r) => setTimeout(r, step.sleep));
      } else if (step.blocked !== undefined) {
        const ctrl = await conn(-1);
        const deadline = Date.now() + 5_000;
        while ((await blockedClients(ctrl)) < step.blocked && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      } else if (step.read !== undefined) {
        const c = await conn(ci);
        for (let k = 0; k < step.read; k++) out.push({ label: `${tag}(read)`, reply: norm(await c.reply(timeout)) });
      } else if (step.scan !== undefined) {
        out.push({ label: `${tag}(full scan) ${step.scan}`, reply: await fullScan(await conn(ci), argv(step.scan), norm) });
      } else if (step.cmd !== undefined) {
        const args = argv(step.cmd);
        const c = await conn(ci);
        const label = `${tag}${args.map((a) => (/^[\x21-\x7e]+$/.test(a) ? a : show(a))).join(' ')}`;
        c.send(args);
        if (step.wait === false) {
          out.push({ label: `${label} (sent)`, reply: '' });
          continue;
        }
        const n = replyCount(args, step);
        for (let k = 0; k < n; k++) out.push({ label, reply: norm(await c.reply(timeout)) });
      }
    }
  } finally {
    for (const c of conns.values()) c.close();
  }
  return out;
}

/** Iterates a SCAN-family command to the end; returns the sorted, de-duplicated elements as a RESP2 array. */
async function fullScan(c: DiffConnection, args: string[], norm: Normalizer): Promise<string> {
  const at = /^scan$/i.test(args[0]) ? 1 : 2;
  const pairs = /^(hscan|zscan)$/i.test(args[0]) && !args.some((a) => /^novalues$/i.test(a));
  const seen = new Set<string>();
  let cursor = '0';
  for (let round = 0; round < 10_000; round++) {
    const sent = [...args];
    sent[at] = cursor;
    const reply = await c.call(sent);
    if (!reply.startsWith('*2')) return norm(reply); // an error: compare it as is
    const node = parseResp(reply).node;
    cursor = payload(node.children[0]);
    const items = node.children[1].children;
    for (let i = 0; i < items.length; i += pairs ? 2 : 1) {
      seen.add(pairs ? `${items[i].raw}${items[i + 1].raw}` : items[i].raw);
    }
    if (cursor === '0') break;
  }
  const list = [...seen].sort();
  return norm(`*${list.length}\r\n${list.join('')}`);
}

/** Two servers: a fresh redis-lite per scenario and one oracle for the whole suite. */
class DiffEnv {
  oracle!: Oracle;
  private ctrl!: DiffConnection;
  private baseline = new Map<string, string>();
  private readonly dir = tempDir('redis-lite-diff-');

  constructor(private readonly bin: string) {}

  async start(): Promise<void> {
    this.oracle = await Oracle.start(this.bin);
    this.ctrl = await DiffConnection.open(this.oracle.port);
    this.baseline = await this.config();
  }

  async stop(): Promise<void> {
    this.ctrl?.close();
    await this.oracle?.stop();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async config(): Promise<Map<string, string>> {
    const node = parseResp(await this.ctrl.call(['CONFIG', 'GET', '*'])).node;
    const map = new Map<string, string>();
    for (let i = 0; i < node.children.length; i += 2) map.set(payload(node.children[i]), payload(node.children[i + 1]));
    return map;
  }

  /** Puts the oracle back in its initial state: no other client, empty keyspace, no scripts, stats reset. */
  async reset(): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = payload(parseResp(await this.ctrl.call(['CLIENT', 'LIST'])).node).trim().split('\n');
      if (list.length <= 1 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const cmd of [['FLUSHALL'], ['SCRIPT', 'FLUSH'], ['FUNCTION', 'FLUSH'], ['CONFIG', 'RESETSTAT'], ['SLOWLOG', 'RESET']]) {
      await this.ctrl.call(cmd);
    }
  }

  /** Re-applies the startup value of every parameter a scenario changed with CONFIG SET. */
  async restoreConfig(): Promise<void> {
    const now = await this.config();
    for (const [k, val] of now) {
      const base = this.baseline.get(k);
      if (base !== undefined && base !== val) await this.ctrl.call(['CONFIG', 'SET', k, base]);
    }
  }

  /** Runs `scenario` on both servers; returns both transcripts. */
  async run(scenario: Scenario, proto: 2 | 3): Promise<{ oracle: Entry[]; lite: Entry[] }> {
    await this.reset();
    const lite = await RedisLite.start({ port: 0, save: '', dir: this.dir });
    try {
      const [o, l] = await Promise.all([execute(this.oracle.port, scenario, proto), execute(lite.port, scenario, proto)]);
      return { oracle: o, lite: l };
    } finally {
      await lite.close();
      if (scenario.fresh) await this.restart();
      else if (scenario.steps.some((st) => /config/i.test(typeof st === 'string' ? st : String(st.cmd ?? '')))) await this.restoreConfig();
    }
  }

  /** A fresh redis-lite and the reset oracle, for suites that drive both by hand (DUMP / RESTORE across servers). */
  async pair(proto: 2 | 3): Promise<{ oracle: DiffConnection; lite: DiffConnection; close: () => Promise<void> }> {
    await this.reset();
    const server = await RedisLite.start({ port: 0, save: '', dir: this.dir });
    const oracle = await openConnection(this.oracle.port, proto);
    const lite = await openConnection(server.port, proto);
    return {
      oracle,
      lite,
      close: async () => {
        oracle.close();
        lite.close();
        await server.close();
      },
    };
  }
}

function render(entries: Entry[]): string {
  return entries.map((e) => `${e.label}\n  -> ${show(e.reply)}`).join('\n');
}

/** Appends the first differing step of a mismatch to DIFF_REPORT (JSON lines), for docs/DIFFERENTIAL.md. */
function report(group: string, scenario: Scenario, proto: 2 | 3, oracle: Entry[], lite: Entry[]): void {
  const file = process.env.DIFF_REPORT;
  if (!file) return;
  const i = oracle.findIndex((e, k) => e.label !== lite[k]?.label || e.reply !== lite[k]?.reply);
  const at = i < 0 ? oracle.length : i;
  appendFileSync(file, `${JSON.stringify({
    group,
    scenario: scenario.name,
    proto,
    known: scenario.diff && (!scenario.diff.proto || scenario.diff.proto === proto) ? scenario.diff : undefined,
    step: oracle[at]?.label ?? lite[at]?.label,
    redis: oracle[at]?.reply,
    lite: lite[at]?.reply,
  })}\n`);
}

export interface DifferentialHooks {
  /** The suite's environment (valid inside tests). */
  env: () => DiffEnv;
}

/**
 * Registers one describe block per group: every scenario × protocol is one test. Skipped (cleanly) when no oracle
 * binary is available. `extra` adds hand-written differential tests that use the same oracle.
 */
export function differential(group: string, scenarios: Scenario[], extra?: (hooks: DifferentialHooks) => void): void {
  const bin = oracleBinary();
  const names = new Set<string>();
  for (const sc of scenarios) {
    if (names.has(sc.name)) throw new Error(`differential ${group}: duplicate scenario name '${sc.name}'`);
    names.add(sc.name);
  }
  describe.skipIf(!bin)(`differential: ${group}`, () => {
    let env: DiffEnv;
    if (bin) env = new DiffEnv(bin);
    beforeAll(async () => env.start(), 60_000);
    afterAll(async () => env?.stop());
    for (const sc of scenarios) {
      for (const proto of [2, 3] as const) {
        if (sc.proto && sc.proto !== proto) continue;
        const known = sc.diff && (!sc.diff.proto || sc.diff.proto === proto);
        const title = `${sc.name} [RESP${proto}]${known ? ` (version: ${sc.diff?.why})` : ''}`;
        (known ? it.fails : it)(title, async () => {
          const { oracle, lite } = await env.run(sc, proto);
          const a = render(oracle);
          const b = render(lite);
          if (a !== b) report(group, sc, proto, oracle, lite);
          expect(b).toBe(a);
        }, sc.testTimeout);
      }
    }
    extra?.({ env: () => env });
  });
}
