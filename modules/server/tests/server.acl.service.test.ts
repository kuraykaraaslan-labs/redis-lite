import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { errOf, pairs } from './server.test_helpers';

/**
 * ACL.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('ACL', () => {
  it('WHOAMI / USERS / LIST', async () => {
    expect.soft(await t.call('ACL', 'WHOAMI')).toBe('default');
    expect.soft(await t.call('ACL', 'USERS')).toEqual(['default']);
    expect.soft(await t.call('ACL', 'LIST')).toEqual(['user default on nopass sanitize-payload ~* &* +@all']);
  });

  it('CAT lists categories and the commands in a category', async () => {
    const cats = (await t.call('ACL', 'CAT')) as string[];
    expect.soft(cats).toEqual(
      expect.arrayContaining([
        'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo',
        'stream', 'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
      ]),
    );
    const str = (await t.call('ACL', 'CAT', 'string')) as string[];
    expect.soft(str).toEqual(expect.arrayContaining(['get', 'set', 'incr', 'append']));
    expect.soft(str).not.toContain('lpush');
    expect.soft(await errOf(t.call('ACL', 'CAT', 'nosuchcat'))).toBe("ERR Unknown category 'nosuchcat'");
  });

  it('GETUSER default', async () => {
    const u = pairs(await t.call('ACL', 'GETUSER', 'default'));
    expect.soft(u.flags).toEqual(['on', 'nopass', 'sanitize-payload']);
    expect.soft(u.passwords).toEqual([]);
    expect.soft(u.commands).toBe('+@all');
    expect.soft(u.keys).toBe('~*');
    expect.soft(u.channels).toBe('&*');
    expect.soft(u.selectors).toEqual([]);
    expect.soft(await t.call('ACL', 'GETUSER', 'nosuchuser')).toBeNull();
  });

  it('GETUSER in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft((await r.send('ACL', 'GETUSER', 'default')).startsWith('%6\r\n$5\r\nflags\r\n')).toBe(true);
    expect.soft(await r.send('ACL', 'GETUSER', 'nosuchuser')).toBe('_\r\n');
  });

  it('GENPASS', async () => {
    expect.soft(await t.call('ACL', 'GENPASS')).toMatch(/^[0-9a-f]{64}$/);
    expect.soft(await t.call('ACL', 'GENPASS', '32')).toMatch(/^[0-9a-f]{8}$/);
    expect.soft(await t.call('ACL', 'GENPASS', '5')).toMatch(/^[0-9a-f]{2}$/);
    expect.soft(await t.call('ACL', 'GENPASS')).not.toBe(await t.call('ACL', 'GENPASS'));
    const msg = 'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096';
    expect.soft(await errOf(t.call('ACL', 'GENPASS', '0'))).toBe(msg);
    expect.soft(await errOf(t.call('ACL', 'GENPASS', '5000'))).toBe(msg);
  });

  it('DRYRUN', async () => {
    expect.soft(await t.call('ACL', 'DRYRUN', 'default', 'GET', 'k')).toBe('OK');
    expect.soft(await errOf(t.call('ACL', 'DRYRUN', 'nosuchuser', 'GET', 'k'))).toBe("ERR User 'nosuchuser' not found");
    // unverified: exact wording for an unknown command
    expect.soft(await errOf(t.call('ACL', 'DRYRUN', 'default', 'NOSUCHCMD'))).toBe("ERR Command 'NOSUCHCMD' not found");
  });

  it('LOG is empty and can be reset', async () => {
    // earlier tests in this file fail AUTH / HELLO AUTH, which Redis records in the ACL LOG
    expect.soft(await t.call('ACL', 'LOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('ACL', 'LOG')).toEqual([]);
    expect.soft(await t.call('ACL', 'LOG', '5')).toEqual([]);
    expect.soft(await t.call('ACL', 'LOG', 'RESET')).toBe('OK');
  });

  it('unknown subcommand and arity', async () => {
    expect.soft(await errOf(t.call('ACL', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try ACL HELP.");
    expect.soft(await errOf(t.call('ACL', 'WHOAMI', 'x'))).toBe("ERR wrong number of arguments for 'acl|whoami' command");
    expect.soft(await errOf(t.call('ACL'))).toBe("ERR wrong number of arguments for 'acl' command");
  });
});
