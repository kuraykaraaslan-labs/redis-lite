// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.

/**
 * Source of the MIGRATE network thread (run with `new Worker(source, { eval: true })`, so it is plain CommonJS and
 * works the same from the TypeScript sources and from the build). MIGRATE blocks the server like Redis does: the main
 * thread posts one exchange, waits on a shared cell (Atomics.wait) and reads the outcome synchronously, while this
 * thread talks to the target.
 *
 * One exchange: get the cached connection to host:port (or connect, within `timeout` ms), write the whole pipeline
 * ([AUTH], [SELECT db] when the connection's current db differs, the RESTOREs), then read one reply line per command,
 * each within `timeout` ms. The outcome is `{ kind: 'ok', replies }` (the reply lines, without CRLF) or
 * `{ kind: 'io', stage: 'connect' | 'write' | 'read' }`. An I/O failure closes the connection; one that is not a
 * timeout is retried once on a fresh connection. A reply that is an error leaves the connection's db unknown, so the
 * next exchange selects again. Connections idle for 10 s are closed.
 */
export const MIGRATE_WORKER_SOURCE = String.raw`
'use strict';
const net = require('node:net');
const { workerData } = require('node:worker_threads');
const { cell, port } = workerData;
const IDLE_MS = 10000;
const conns = new Map();

function encode(args) {
  let out = '*' + args.length + '\r\n';
  for (const a of args) out += '$' + Buffer.byteLength(a, 'latin1') + '\r\n' + a + '\r\n';
  return Buffer.from(out, 'latin1');
}

function close(key) {
  const c = conns.get(key);
  if (!c) return;
  conns.delete(key);
  c.sock.destroy();
}

function connect(key, host, portNum, timeout) {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = net.connect({ host, port: portNum });
    } catch {
      resolve({ error: 'write' });
      return;
    }
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ error: 'connect', timeout: true });
    }, timeout);
    sock.once('error', (e) => {
      clearTimeout(timer);
      sock.destroy();
      const lookup = e && (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.syscall === 'getaddrinfo');
      resolve({ error: lookup ? 'connect' : 'write' });
    });
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.removeAllListeners('error');
      sock.setNoDelay(true);
      const c = { sock, db: '-1', used: Date.now(), buf: '', wake: null, dead: false };
      sock.on('data', (d) => {
        c.buf += d.toString('latin1');
        if (c.wake) c.wake();
      });
      const dead = () => {
        c.dead = true;
        if (c.wake) c.wake();
      };
      sock.on('error', dead);
      sock.on('close', dead);
      conns.set(key, c);
      resolve({ conn: c });
    });
  });
}

function readLine(c, timeout) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    let timer = null;
    const attempt = () => {
      const i = c.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = c.buf.slice(0, i);
        c.buf = c.buf.slice(i + 2);
        finish({ line });
      } else if (c.dead) finish({ error: 'read' });
      else if (Date.now() >= deadline) finish({ error: 'read', timeout: true });
    };
    const finish = (r) => {
      c.wake = null;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    c.wake = attempt;
    timer = setTimeout(attempt, timeout);
    attempt();
  });
}

function write(c, data) {
  return new Promise((resolve) => {
    if (c.dead) return resolve(false);
    c.sock.write(data, (err) => resolve(!err));
  });
}

async function attempt(req) {
  const key = req.host + ':' + req.port;
  let c = conns.get(key);
  const cached = Boolean(c);
  if (!c) {
    const portNum = /^[0-9]+$/.test(req.port) ? Number(req.port) : NaN;
    if (!(portNum > 0 && portNum < 65536)) return { result: { kind: 'io', stage: 'write' } };
    const r = await connect(key, req.host, portNum, req.timeout);
    if (r.error) return { result: { kind: 'io', stage: r.error }, retry: !r.timeout && r.error !== 'connect' };
    c = r.conn;
  }
  c.used = Date.now();
  const commands = [];
  if (req.auth) commands.push(req.auth);
  const select = c.db !== req.db;
  if (select) commands.push(['SELECT', req.db]);
  for (const r of req.restores) commands.push(r);
  if (!(await write(c, Buffer.concat(commands.map(encode))))) {
    close(key);
    return { result: { kind: 'io', stage: 'write' }, retry: cached };
  }
  const replies = [];
  for (let i = 0; i < commands.length; i++) {
    const r = await readLine(c, req.timeout);
    if (r.error) {
      close(key);
      return { result: { kind: 'io', stage: 'read' }, retry: !r.timeout };
    }
    replies.push(r.line);
  }
  c.db = replies.some((l) => l.startsWith('-')) ? '-1' : req.db;
  c.used = Date.now();
  return { result: { kind: 'ok', replies } };
}

async function exchange(req) {
  let out = await attempt(req);
  if (out.result.kind === 'io' && out.retry) out = await attempt(req);
  return out.result;
}

port.on('message', async (req) => {
  let result;
  try {
    result = await exchange(req);
  } catch {
    result = { kind: 'io', stage: 'write' };
  }
  port.postMessage({ id: req.id, outcome: result });
  Atomics.store(cell, 0, 1);
  Atomics.notify(cell, 0);
});

setInterval(() => {
  const now = Date.now();
  for (const [key, c] of conns) if (now - c.used > IDLE_MS) close(key);
}, 1000).unref();
`;
