import { beforeAll, describe, expect, it } from 'vitest';

import type { LuaEngine } from '@/modules/scripting/scripting.service';

import { eventually, sleep, useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Busy scripts in cooperative mode (texts checked against Redis 7.0): a script past busy-reply-threshold yields to the
 * event loop, SCRIPT KILL / FUNCTION KILL stop it (UNKILLABLE once it wrote), FUNCTION STATS shows a running function.
 * The BUSY refusal of other commands is the dispatcher's job (LuaEngine.busyRefusal), checked here directly.
 */

const t = useServer();
let lua: LuaEngine;

const BUSY_SCRIPT = '-BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.\r\n';
const BUSY_FUNCTION = '-BUSY Redis is busy running a script. You can only call FUNCTION KILL or SHUTDOWN NOSAVE.\r\n';
const SPIN = 'while true do end';

/** Sends a command without waiting for its reply. */
function send(c: RawClient, ...args: string[]): void {
  void c.send(...args);
}

/** Waits until a script is suspended (busy). */
async function busy(): Promise<void> {
  await eventually(() => expect(lua.running?.suspended).toBe(true));
}

beforeAll(async () => {
  lua = (t.server as unknown as { server: { lua: LuaEngine } }).server.lua;
  lua.cooperative = true;
  await t.call('CONFIG', 'SET', 'busy-reply-threshold', '50');
  await t.call(
    'FUNCTION',
    'LOAD',
    "#!lua name=busy\nredis.register_function('spin', function() while true do end end)\nredis.register_function('quick', function() return 1 end)",
  );
});

describe('busy scripts (cooperative mode)', () => {
  it('SCRIPT KILL stops a busy script; the script client gets the kill error, then runs its next command', async () => {
    const a = await t.raw();
    const b = await t.raw();
    const reply = a.send('EVAL', SPIN, '0');
    await busy();
    expect(await b.send('FUNCTION', 'KILL')).toBe(BUSY_SCRIPT);
    expect(await b.send('FUNCTION', 'STATS')).toBe(BUSY_SCRIPT);
    expect(lua.busyRefusal(['GET', 'x'])?.message).toBe(BUSY_SCRIPT.slice(1, -2));
    expect(lua.busyRefusal(['SCRIPT', 'KILL'])).toBeNull();
    expect(await b.send('EVAL', 'return 1', '0')).toBe(BUSY_SCRIPT);
    expect(await b.send('SCRIPT', 'KILL')).toBe('+OK\r\n');
    const killed = await reply;
    expect(killed).toMatch(/^-ERR Script killed by user with SCRIPT KILL\.\.\. script: [0-9a-f]{40}, on @user_script:1\.\r\n$/);
    expect(await a.send('PING')).toBe('+PONG\r\n');
    expect(lua.running).toBeNull();
    expect(await b.send('SCRIPT', 'KILL')).toBe('-NOTBUSY No scripts in execution right now.\r\n');
  });

  it('FUNCTION KILL stops a busy function; FUNCTION STATS shows it while it runs', async () => {
    const a = await t.raw();
    const b = await t.raw();
    const reply = a.send('FCALL', 'SPIN', '0');
    await busy();
    expect(await b.send('SCRIPT', 'KILL')).toBe(BUSY_FUNCTION);
    const stats = await b.send('FUNCTION', 'STATS');
    expect(stats).toContain('$14\r\nrunning_script\r\n*6\r\n$4\r\nname\r\n$4\r\nspin\r\n$7\r\ncommand\r\n*3\r\n$5\r\nFCALL\r\n$4\r\nSPIN\r\n$1\r\n0\r\n');
    expect(await b.send('FUNCTION', 'KILL')).toBe('+OK\r\n');
    expect(await reply).toBe('-ERR Script killed by user with SCRIPT KILL... script: spin, on @user_function:2.\r\n');
  });

  it('a script that wrote is UNKILLABLE and ends normally', async () => {
    const a = await t.raw();
    const b = await t.raw();
    const reply = a.send('EVAL', "redis.call('SET', 'w', '1') local i = 0 while i < 2e7 do i = i + 1 end return i", '0');
    await busy();
    expect(await b.send('SCRIPT', 'KILL')).toMatch(/^-UNKILLABLE Sorry the script already executed write commands/);
    expect(await reply).toBe(':20000000\r\n');
    expect(await a.send('GET', 'w')).toBe('$1\r\n1\r\n');
  });

  it('a pcall in the script catches the kill error', async () => {
    const a = await t.raw();
    const b = await t.raw();
    const reply = a.send('EVAL', 'pcall(function() while true do end end) return 5', '0');
    await busy();
    expect(await b.send('SCRIPT', 'KILL')).toBe('+OK\r\n');
    expect(await reply).toBe(':5\r\n');
  });

  it('the line of a killed multi-line script', async () => {
    const a = await t.raw();
    const b = await t.raw();
    const reply = a.send('EVAL', '\n\nlocal t = {}\nwhile true do t[1] = 1 end', '0');
    await busy();
    expect(await b.send('SCRIPT', 'KILL')).toBe('+OK\r\n');
    expect(await reply).toMatch(/on @user_script:4\.\r\n$/);
  });

  it('commands pipelined after a busy script wait for its reply', async () => {
    const a = await t.raw();
    const b = await t.raw();
    send(a, 'EVAL', SPIN, '0');
    await busy();
    void a.send('PING');
    await sleep(100);
    expect(a.pending()).toBe('');
    expect(await b.send('SCRIPT', 'KILL')).toBe('+OK\r\n');
    await eventually(() => expect(a.pending()).toMatch(/^-ERR Script killed.*\r\n\+PONG\r\n$/));
  });
});

describe('scripts that cannot be suspended', () => {
  it('a script inside MULTI / EXEC runs to its end in one go', async () => {
    const a = await t.raw();
    await a.send('MULTI');
    await a.send('EVAL', 'local i = 0 while i < 1e7 do i = i + 1 end return i', '0');
    expect(await a.send('EXEC')).toBe('*1\r\n:10000000\r\n');
  });
});
