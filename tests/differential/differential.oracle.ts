import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { assertSafePort, DiffConnection } from './differential.connection';

/**
 * The oracle: a real redis-server started by the harness, used strictly as a black box over the network protocol.
 *
 * Safety: every oracle runs on a random free port (never 6379, see `assertSafePort`), bound to 127.0.0.1, with its own
 * temporary working dir and no persistence (`--save ''`, `--appendonly no`). It is stopped and its dir removed in
 * `stop()` (called from afterAll), on process exit, and by a watchdog shell that outlives a killed test worker.
 */

/** Where the binary is looked for when REDIS_ORACLE_BIN is not set. */
export const DEFAULT_ORACLE_BIN = '/home/kuray/.cache/redis-local/root/usr/bin/redis-server';

/** The redis-server binary to use, or undefined (the differential suites are skipped). */
export function oracleBinary(): string | undefined {
  const fromEnv = process.env.REDIS_ORACLE_BIN;
  if (fromEnv !== undefined) return fromEnv !== '' && existsSync(fromEnv) ? fromEnv : undefined;
  return existsSync(DEFAULT_ORACLE_BIN) ? DEFAULT_ORACLE_BIN : undefined;
}

/** A free TCP port on 127.0.0.1 (asked from the OS; never the forbidden one). */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        const p = typeof address === 'object' && address ? address.port : 0;
        srv.close(() => resolvePort(p));
      });
    });
    try {
      assertSafePort(port);
      return port;
    } catch {
      // the OS handed out the forbidden port: ask again
    }
  }
}

/**
 * Library path for a relocated (unpacked, not installed) binary: its shared libraries sit in `../lib/<triplet>` next
 * to `bin/`. Only the dynamic loader uses these paths while executing the binary; the harness never opens them.
 */
function libraryPath(bin: string): string {
  const prefix = resolve(dirname(bin), '..');
  return [join(prefix, 'lib', 'x86_64-linux-gnu'), join(prefix, 'lib'), process.env.LD_LIBRARY_PATH ?? '']
    .filter((p) => p !== '')
    .join(':');
}

export class Oracle {
  private stopped = false;
  private readonly exitHook = (): void => this.killNow();

  private constructor(
    readonly port: number,
    private readonly child: ChildProcess,
    private readonly dir: string,
  ) {
    process.once('exit', this.exitHook);
  }

  static async start(bin: string): Promise<Oracle> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = await freePort();
      assertSafePort(port);
      const dir = mkdtempSync(join(tmpdir(), 'redis-lite-oracle-'));
      const args = [
        '--port', String(port),
        '--bind', '127.0.0.1',
        '--save', '',
        '--appendonly', 'no',
        '--dir', dir,
        '--enable-debug-command', 'yes',
        '--daemonize', 'no',
        '--loglevel', 'warning',
        '--logfile', '',
      ];
      const child = spawn(bin, args, { cwd: dir, stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: libraryPath(bin) } });
      watchdog(child, dir);
      const oracle = new Oracle(port, child, dir);
      try {
        await oracle.ready();
        return oracle;
      } catch (e) {
        lastError = e;
        await oracle.stop();
      }
    }
    throw new Error(`differential harness: could not start the oracle: ${String(lastError)}`);
  }

  /** Waits until the server answers PING (fails fast when the process exits, e.g. the port was taken). */
  private async ready(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('oracle exited during startup');
      try {
        const c = await DiffConnection.open(this.port, 500);
        const pong = await c.call(['PING'], 1_000);
        c.close();
        if (pong === '+PONG\r\n') return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('oracle did not answer PING');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private killNow(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    rmSync(this.dir, { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    process.removeListener('exit', this.exitHook);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise<void>((r) => this.child.once('exit', () => r()));
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * A detached shell that kills the oracle and removes its dir if the test process dies without running its hooks
 * (a SIGKILLed worker). It exits by itself once the oracle is gone.
 */
function watchdog(child: ChildProcess, dir: string): void {
  if (child.pid === undefined) return;
  const script = `while kill -0 ${process.pid} 2>/dev/null && kill -0 ${child.pid} 2>/dev/null; do sleep 1; done; ` +
    `kill -9 ${child.pid} 2>/dev/null; rm -rf '${dir.replace(/'/g, '')}'`;
  spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
}
