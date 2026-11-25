import { describe, expect, it } from 'vitest';

import { CommandError } from '@/libs/app-error';

import {
  ACL_CATEGORIES,
  Acl,
  aclDenialMessage,
  aclGlobMatch,
  genPass,
  hashPassword,
  noPermError,
} from '../acl.core';

const CATS: Record<string, string[]> = {
  get: ['@read', '@string', '@fast'],
  set: ['@write', '@string', '@slow'],
  del: ['@keyspace', '@write', '@slow'],
  copy: ['@keyspace', '@write', '@slow'],
  hget: ['@read', '@hash', '@fast'],
  lpush: ['@write', '@list', '@fast'],
  select: ['@fast', '@connection'],
  auth: ['@fast', '@connection'],
  publish: ['@pubsub', '@fast'],
  subscribe: ['@pubsub', '@slow'],
  psubscribe: ['@pubsub', '@slow'],
  flushall: ['@keyspace', '@write', '@slow', '@dangerous'],
  config: ['@slow'],
  'config|get': ['@admin', '@slow', '@dangerous'],
  'config|set': ['@admin', '@slow', '@dangerous'],
  client: ['@slow'],
  'client|getname': ['@slow', '@connection'],
  'client|kill': ['@admin', '@slow', '@dangerous', '@connection'],
};

const FOO_HASH = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';

function makeAcl(opts: { requirepass?: string; now?: () => number; logMaxLen?: number } = {}): Acl {
  return new Acl({ allCommands: () => Object.keys(CATS), categoriesOf: (c) => CATS[c] ?? [], ...opts });
}

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommandError) return e.message;
    throw e;
  }
  throw new Error('expected an error');
}

const rw = (key: string) => ({ key, read: true, write: true });
const r = (key: string) => ({ key, read: true, write: false });
const w = (key: string) => ({ key, read: false, write: true });

describe('default user', () => {
  it('is on nopass with every permission', () => {
    const acl = makeAcl();
    expect(acl.describe('default')).toBe('user default on nopass sanitize-payload ~* &* +@all');
    expect(acl.authenticate('default', 'anything')).toBe(true);
    expect(acl.defaultLoginAllowed()).toBe(true);
    expect(acl.users()).toEqual(['default']);
  });

  it('takes requirepass', () => {
    const acl = makeAcl({ requirepass: 'foo' });
    expect(acl.describe('default')).toBe(`user default on sanitize-payload #${FOO_HASH} ~* &* +@all`);
    expect(acl.authenticate('default', 'foo')).toBe(true);
    expect(acl.authenticate('default', 'bar')).toBe(false);
    expect(acl.defaultLoginAllowed()).toBe(false);
    acl.setRequirePass('');
    expect(acl.describe('default')).toBe('user default on nopass sanitize-payload ~* &* +@all');
  });

  it('cannot be deleted', () => {
    const acl = makeAcl();
    acl.setUser('a', []);
    expect(errorOf(() => acl.deleteUser(['a', 'default']))).toBe("ERR The 'default' user cannot be removed");
    expect(acl.users()).toEqual(['a', 'default']);
    expect(acl.deleteUser(['a', 'nope'])).toBe(1);
  });
});

describe('ACL SETUSER rule language and describe()', () => {
  it('creates a new user with the Redis defaults', () => {
    const acl = makeAcl();
    acl.setUser('alice', []);
    expect(acl.describe('alice')).toBe('user alice off sanitize-payload resetchannels -@all');
  });

  it('normalises the documented example', () => {
    const acl = makeAcl();
    acl.setUser('alice', ['on', '>foo', '~cached:*', '+get']);
    expect(acl.describe('alice')).toBe(`user alice on sanitize-payload #${FOO_HASH} ~cached:* resetchannels -@all +get`);
  });

  it('keeps command rule order and drops superseded rules', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+@all', '-@write', '+SET', '-get', '+get']);
    expect(acl.getUser('u')?.commands).toBe('+@all -@write +set +get');
    acl.setUser('u', ['+config|get', '+client|getname', '+config']);
    expect(acl.getUser('u')?.commands).toBe('+@all -@write +set +get +client|getname +config');
    acl.setUser('u', ['-config|set']);
    expect(acl.getUser('u')?.commands).toBe('+@all -@write +set +get +client|getname +config -config|set');
    acl.setUser('u', ['nocommands']);
    expect(acl.getUser('u')?.commands).toBe('-@all');
    acl.setUser('u', ['allcommands', '-@DANGEROUS']);
    expect(acl.getUser('u')?.commands).toBe('+@all -@dangerous');
  });

  it('key patterns with read/write permissions', () => {
    const acl = makeAcl();
    acl.setUser('u', ['%R~foo', '%W~foo', '%RW~bar', '%r~ro:*', '%W~wo:*', '~a']);
    expect(acl.getUser('u')?.keys).toBe('~foo ~bar %R~ro:* %W~wo:* ~a');
    acl.setUser('u', ['allkeys']);
    expect(acl.getUser('u')?.keys).toBe('~*');
    acl.setUser('u', ['resetkeys', '%R~*']);
    expect(acl.getUser('u')?.keys).toBe('%R~*');
    acl.setUser('u', ['%RW~*']);
    expect(acl.getUser('u')?.keys).toBe('~*');
  });

  it('channels', () => {
    const acl = makeAcl();
    acl.setUser('u', ['&news.*', '&news.*', '&chat']);
    expect(acl.describe('u')).toBe('user u off sanitize-payload resetchannels &news.* &chat -@all');
    expect(acl.getUser('u')?.channels).toBe('&news.* &chat');
    acl.setUser('u', ['allchannels']);
    expect(acl.describe('u')).toBe('user u off sanitize-payload &* -@all');
    acl.setUser('u', ['resetchannels']);
    expect(acl.getUser('u')?.channels).toBe('');
  });

  it('flags and passwords', () => {
    const acl = makeAcl();
    acl.setUser('u', ['on', 'skip-sanitize-payload', '>foo', '>foo', `#${'a'.repeat(64)}`]);
    expect(acl.getUser('u')?.flags).toEqual(['on', 'skip-sanitize-payload']);
    expect(acl.getUser('u')?.passwords).toEqual([FOO_HASH, 'a'.repeat(64)]);
    acl.setUser('u', ['<foo', `!${'a'.repeat(64)}`]);
    expect(acl.getUser('u')?.passwords).toEqual([]);
    acl.setUser('u', ['>foo', 'nopass']);
    expect(acl.getUser('u')?.flags).toEqual(['on', 'nopass', 'skip-sanitize-payload']);
    expect(acl.getUser('u')?.passwords).toEqual([]);
    acl.setUser('u', ['resetpass']);
    expect(acl.getUser('u')?.flags).toEqual(['on', 'skip-sanitize-payload']);
  });

  it('reset returns to a fresh user', () => {
    const acl = makeAcl();
    acl.setUser('u', ['on', '>x', '~*', '&*', '+@all', '(~a +get)', 'skip-sanitize-payload']);
    acl.setUser('u', ['reset']);
    expect(acl.describe('u')).toBe('user u off sanitize-payload resetchannels -@all');
  });

  it('selectors', () => {
    const acl = makeAcl();
    acl.setUser('u', ['on', 'nopass', '+get', '~a:*', '(+set', '~b:*', '&c)', '(%R~x +@read)']);
    expect(acl.describe('u')).toBe(
      'user u on nopass sanitize-payload ~a:* resetchannels -@all +get (~b:* resetchannels &c -@all +set) (%R~x resetchannels -@all +@read)',
    );
    expect(acl.getUser('u')).toEqual({
      flags: ['on', 'nopass', 'sanitize-payload'],
      passwords: [],
      commands: '-@all +get',
      keys: '~a:*',
      channels: '',
      selectors: [
        { commands: '-@all +set', keys: '~b:*', channels: '&c' },
        { commands: '-@all +@read', keys: '%R~x', channels: '' },
      ],
    });
    acl.setUser('u', ['clearselectors']);
    expect(acl.getUser('u')?.selectors).toEqual([]);
  });

  it('first-arg rules on commands without subcommands', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+select|0']);
    expect(acl.getUser('u')?.commands).toBe('-@all +select|0');
    expect(acl.check('u', 'select', null, ['0'])).toBeNull();
    expect(acl.check('u', 'select', null, ['1'])).toEqual({ reason: 'command', object: 'select' });
    acl.setUser('u', ['-select']);
    expect(acl.getUser('u')?.commands).toBe('-@all -select');
    expect(acl.check('u', 'select', null, ['0'])).not.toBeNull();
  });

  it('round-trips every description through setUser', () => {
    const acl = makeAcl();
    acl.setUser('u', ['on', '>foo', '%R~r:*', '~k', '&ch', '+@all', '-@write', '+set', '-config|set', '(~z +get)']);
    const line = acl.describe('u') ?? '';
    const rules = line.split(' ').slice(2);
    acl.setUser('v', rules);
    expect(acl.describe('v')).toBe(line.replace('user u ', 'user v '));
  });
});

describe('ACL SETUSER errors', () => {
  const acl = makeAcl();
  const cases: Array<[string[], string]> = [
    [['bogus'], "ERR Error in ACL SETUSER modifier 'bogus': Syntax error"],
    [['+nosuchcmd'], "ERR Error in ACL SETUSER modifier '+nosuchcmd': Unknown command or category name in ACL"],
    [['-nosuchcmd'], "ERR Error in ACL SETUSER modifier '-nosuchcmd': Unknown command or category name in ACL"],
    [['+@nosuchcat'], "ERR Error in ACL SETUSER modifier '+@nosuchcat': Unknown command or category name in ACL"],
    [['+config|nosuch'], "ERR Error in ACL SETUSER modifier '+config|nosuch': Unknown command or category name in ACL"],
    [['-select|0'], "ERR Error in ACL SETUSER modifier '-select|0': Unknown command or category name in ACL"],
    [['+config|get|x'], "ERR Error in ACL SETUSER modifier '+config|get|x': Allowing first-arg of a subcommand is not supported"],
    [['+get|'], "ERR Error in ACL SETUSER modifier '+get|': Syntax error"],
    [['~*', '~foo'], "ERR Error in ACL SETUSER modifier '~foo': Adding a pattern after the * pattern (or the 'allkeys' flag) is not valid and does not have any effect. Try 'resetkeys' to start with an empty list of patterns"],
    [['&*', '&foo'], "ERR Error in ACL SETUSER modifier '&foo': Adding a pattern after the * pattern (or the 'allchannels' flag) is not valid and does not have any effect. Try 'resetchannels' to start with an empty list of channels"],
    [['<nope'], "ERR Error in ACL SETUSER modifier '<nope': The password you are trying to remove from the user does not exist"],
    [['#abc'], "ERR Error in ACL SETUSER modifier '#abc': The password hash must be exactly 64 characters and contain only lowercase hexadecimal characters"],
    [[`#${'A'.repeat(64)}`], `ERR Error in ACL SETUSER modifier '#${'A'.repeat(64)}': The password hash must be exactly 64 characters and contain only lowercase hexadecimal characters`],
    [['%X~foo'], "ERR Error in ACL SETUSER modifier '%X~foo': Syntax error"],
    [['%RR~foo'], "ERR Error in ACL SETUSER modifier '%RR~foo': Syntax error"],
    [['(on)'], "ERR Error in ACL SETUSER modifier '(on)': Syntax error"],
    [['(+get', '+nosuch)'], "ERR Error in ACL SETUSER modifier '(+get +nosuch)': Unknown command or category name in ACL"],
    [['(+get', '~x'], "ERR Unmatched parenthesis in acl selector starting at '(+get'."],
  ];
  for (const [rules, msg] of cases) {
    it(rules.join(' '), () => {
      expect(errorOf(() => acl.setUser('e', rules))).toBe(msg);
    });
  }

  it('rejects usernames with spaces', () => {
    expect(errorOf(() => acl.setUser('a b', []))).toBe("ERR Usernames can't contain spaces or null characters");
  });

  it('applies nothing on error (atomic)', () => {
    const a = makeAcl();
    a.setUser('x', ['on', '+get']);
    expect(() => a.setUser('x', ['off', '+set', '+nosuch'])).toThrow(CommandError);
    expect(a.describe('x')).toBe('user x on sanitize-payload resetchannels -@all +get');
    expect(() => a.setUser('y', ['+nosuch'])).toThrow(CommandError);
    expect(a.user('y')).toBeUndefined();
  });

  it('keeps the user object identity across SETUSER', () => {
    const a = makeAcl();
    a.setUser('x', []);
    const obj = a.user('x');
    a.setUser('x', ['on']);
    expect(a.user('x')).toBe(obj);
    expect(obj?.enabled).toBe(true);
  });
});

describe('authentication', () => {
  it('checks sha256 passwords and the on/off flag', () => {
    const acl = makeAcl();
    expect(hashPassword('foo')).toBe(FOO_HASH);
    acl.setUser('u', ['>foo']);
    expect(acl.authenticate('u', 'foo')).toBe(false); // off
    acl.setUser('u', ['on']);
    expect(acl.authenticate('u', 'foo')).toBe(true);
    expect(acl.authenticate('u', 'bar')).toBe(false);
    acl.setUser('v', ['on', `#${FOO_HASH}`]);
    expect(acl.authenticate('v', 'foo')).toBe(true);
    acl.setUser('w', ['on']);
    expect(acl.authenticate('w', '')).toBe(false); // no passwords, not nopass
    expect(acl.authenticate('nobody', 'foo')).toBe(false);
  });
});

describe('permission checks', () => {
  it('commands, categories and subcommands', () => {
    const acl = makeAcl();
    acl.setUser('u', ['on', 'nopass', '~*', '+@read', '-hget', '+config|get', '+client']);
    expect(acl.check('u', 'get', null, ['k'], [r('k')])).toBeNull();
    expect(acl.check('u', 'hget', null, ['k', 'f'], [r('k')])).toEqual({ reason: 'command', object: 'hget' });
    expect(acl.check('u', 'set', null, ['k', 'v'], [w('k')])).toEqual({ reason: 'command', object: 'set' });
    expect(acl.check('u', 'config', 'get', ['get', 'x'])).toBeNull();
    expect(acl.check('u', 'config', 'set', ['set', 'x', 'y'])).toEqual({ reason: 'command', object: 'config|set' });
    expect(acl.check('u', 'client', 'kill', ['kill'])).toBeNull();
    acl.setUser('u', ['-@dangerous']);
    expect(acl.check('u', 'client', 'kill', ['kill'])).toEqual({ reason: 'command', object: 'client|kill' });
    expect(acl.check('u', 'client', 'getname', ['getname'])).toBeNull();
    expect(acl.check('u', 'auth', null, ['x'], [], { noauth: true })).toBeNull();
  });

  it('+@all minus a category', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+@all', '-@write', '+del']);
    expect(acl.check('u', 'get', null, [])).toBeNull();
    expect(acl.check('u', 'set', null, [])).not.toBeNull();
    expect(acl.check('u', 'del', null, [])).toBeNull();
  });

  it('key read/write patterns', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+@all', '%R~ro:*', '%W~wo:*', '~rw:*']);
    expect(acl.check('u', 'get', null, ['ro:1'], [r('ro:1')])).toBeNull();
    expect(acl.check('u', 'set', null, ['ro:1', 'v'], [w('ro:1')])).toEqual({ reason: 'key', object: 'ro:1' });
    expect(acl.check('u', 'set', null, ['wo:1', 'v'], [w('wo:1')])).toBeNull();
    expect(acl.check('u', 'get', null, ['wo:1'], [r('wo:1')])).toEqual({ reason: 'key', object: 'wo:1' });
    expect(acl.check('u', 'lpush', null, ['rw:1'], [rw('rw:1')])).toBeNull();
    expect(acl.check('u', 'lpush', null, ['ro:1'], [rw('ro:1')])).not.toBeNull();
    // COPY src dst: reads src, writes dst.
    expect(acl.check('u', 'copy', null, ['ro:a', 'wo:b'], [r('ro:a'), w('wo:b')])).toBeNull();
    expect(acl.check('u', 'copy', null, ['ro:a', 'other'], [r('ro:a'), w('other')])).toEqual({ reason: 'key', object: 'other' });
    // Keys flagged neither read nor write match any pattern.
    expect(acl.check('u', 'del', null, ['wo:1'], [{ key: 'ro:x', read: false, write: false }])).toBeNull();
  });

  it('channels', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+@all', '&news.*', '&chat']);
    expect(acl.check('u', 'publish', null, ['news.tech', 'hi'])).toBeNull();
    expect(acl.check('u', 'publish', null, ['other', 'hi'])).toEqual({ reason: 'channel', object: 'other' });
    expect(acl.check('u', 'subscribe', null, ['chat', 'news.x'])).toBeNull();
    expect(acl.check('u', 'subscribe', null, ['chat', 'nope'])).toEqual({ reason: 'channel', object: 'nope' });
    // Patterns are compared literally.
    expect(acl.check('u', 'psubscribe', null, ['news.*'])).toBeNull();
    expect(acl.check('u', 'psubscribe', null, ['news.t*'])).toEqual({ reason: 'channel', object: 'news.t*' });
    expect(acl.channelAllowed('u', 'news.a', false)).toBe(true);
    expect(acl.channelAllowed('u', 'x', false)).toBe(false);
  });

  it('selectors: any selector may allow; the most relevant denial is reported', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+get', '~a:*', '(+set ~b:*)', '(+get %R~c:*)']);
    expect(acl.check('u', 'get', null, ['a:1'], [r('a:1')])).toBeNull();
    expect(acl.check('u', 'get', null, ['c:1'], [r('c:1')])).toBeNull();
    expect(acl.check('u', 'set', null, ['b:1', 'v'], [w('b:1')])).toBeNull();
    expect(acl.check('u', 'set', null, ['a:1', 'v'], [w('a:1')])).toEqual({ reason: 'key', object: 'a:1' });
    expect(acl.check('u', 'del', null, ['a:1'], [w('a:1')])).toEqual({ reason: 'command', object: 'del' });
    expect(acl.check('u', 'get', null, ['z'], [r('z')])).toEqual({ reason: 'key', object: 'z' });
  });

  it('error texts', () => {
    expect(noPermError({ reason: 'command', object: 'config|get' }, 'alice')).toBe(
      "NOPERM User alice has no permissions to run the 'config|get' command",
    );
    expect(noPermError({ reason: 'key', object: 'k' }, 'alice')).toBe('NOPERM No permissions to access a key');
    expect(noPermError({ reason: 'channel', object: 'c' }, 'alice')).toBe('NOPERM No permissions to access a channel');
    expect(aclDenialMessage({ reason: 'key', object: 'k' }, 'alice', true)).toBe("No permissions to access the 'k' key");
    expect(aclDenialMessage({ reason: 'channel', object: 'c' }, 'alice', true)).toBe(
      "No permissions to access the 'c' channel",
    );
  });

  it('dryRun', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+get', '~a']);
    expect(acl.dryRun('u', 'get', null, ['a'], [r('a')])).toBeNull();
    expect(acl.dryRun('u', 'get', null, ['b'], [r('b')])).toBe("No permissions to access the 'b' key");
    expect(acl.dryRun('u', 'set', null, ['a', 'v'], [w('a')])).toBe("User u has no permissions to run the 'set' command");
    expect(errorOf(() => acl.dryRun('nobody', 'get', null, []))).toBe("ERR User 'nobody' not found");
  });
});

describe('glob matching', () => {
  it('follows stringmatchlen', () => {
    expect(aclGlobMatch('a*', 'abc')).toBe(true);
    expect(aclGlobMatch('a?c', 'abc')).toBe(true);
    expect(aclGlobMatch('a[bx]c', 'axc')).toBe(true);
    expect(aclGlobMatch('a[^b]c', 'abc')).toBe(false);
    expect(aclGlobMatch('a[a-c]', 'ab')).toBe(true);
    expect(aclGlobMatch('a\\*', 'a*')).toBe(true);
    expect(aclGlobMatch('a\\*', 'ab')).toBe(false);
    expect(aclGlobMatch('*', '')).toBe(false); // stringmatchlen quirk: empty string never enters the loop
    expect(aclGlobMatch('', '')).toBe(true);
    expect(aclGlobMatch('a', '')).toBe(false);
  });
});

describe('ACL LOG', () => {
  it('groups same reason/context/object/username within 60s', () => {
    let t = 1_000_000;
    const acl = makeAcl({ now: () => t });
    const base = { reason: 'command', context: 'toplevel', object: 'get', username: 'u' } as const;
    acl.log({ ...base, clientInfo: 'c1' });
    t += 1000;
    acl.log({ ...base, clientInfo: 'c2' });
    let entries = acl.logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      count: 2,
      clientInfo: 'c2',
      entryId: 0,
      timestampCreated: 1_000_000,
      timestampLastUpdated: 1_001_000,
      ageSeconds: 0,
    });
    acl.log({ ...base, object: 'set', clientInfo: 'c3' });
    t += 61_000;
    acl.log({ ...base, clientInfo: 'c4' });
    entries = acl.logEntries();
    expect(entries.map((e) => [e.object, e.count, e.entryId])).toEqual([
      ['get', 1, 2],
      ['set', 1, 1],
      ['get', 2, 0],
    ]);
    expect(entries[1].ageSeconds).toBe(61);
    expect(acl.logEntries(1)).toHaveLength(1);
    acl.logDenial({ reason: 'key', object: 'k' }, 'u', 'multi', 'c5');
    expect(acl.logEntries(1)[0]).toMatchObject({ reason: 'key', context: 'multi', object: 'k' });
    acl.resetLog();
    expect(acl.logEntries()).toEqual([]);
  });

  it('is bounded by acllog-max-len', () => {
    const acl = makeAcl({ logMaxLen: 3 });
    for (let i = 0; i < 5; i++) acl.log({ reason: 'auth', context: 'toplevel', object: 'AUTH', username: `u${i}`, clientInfo: '' });
    expect(acl.logEntries(10).map((e) => e.username)).toEqual(['u4', 'u3', 'u2']);
  });
});

describe('ACL file', () => {
  it('saves and loads', () => {
    const acl = makeAcl();
    acl.setUser('bob', ['on', '>foo', '~b:*', '+get', '(+set ~x)']);
    const text = acl.toFile();
    expect(text).toBe(
      `user bob on sanitize-payload #${FOO_HASH} ~b:* resetchannels -@all +get (~x resetchannels -@all +set)\n` +
        'user default on nopass sanitize-payload ~* &* +@all\n',
    );
    const other = makeAcl();
    other.setUser('gone', []);
    expect(other.loadFile(text)).toEqual(['gone']);
    expect(other.toFile()).toBe(text);
  });

  it('recreates the default user when missing and reports changed users', () => {
    const acl = makeAcl({ requirepass: 'foo' });
    acl.setUser('a', ['on']);
    expect(acl.loadFile('user a on\n\n  \r\n')).toEqual(['default']);
    expect(acl.describe('default')).toBe('user default on nopass sanitize-payload ~* &* +@all');
  });

  it('validates everything and keeps the old users on error', () => {
    const acl = makeAcl();
    acl.setUser('a', ['on']);
    const before = acl.toFile();
    expect(errorOf(() => acl.loadFile('user b on +nosuch +nope bogus %X~a\nfoo bar\nuser b\nuser c (+get', 'users.acl'))).toBe(
      "ERR users.acl:1: Error in applying operation '+nosuch': Unknown command or category name in ACL. " +
        "users.acl:1: Error in applying operation '+nope': Unknown command or category name in ACL. " +
        'users.acl:1: Syntax error. ' +
        'users.acl:2 should start with user keyword. ' +
        "WARNING: Duplicate user 'b' found on line 3. " +
        'users.acl:4: Unmatched parenthesis in selector definition.',
    );
    expect(acl.toFile()).toBe(before);
  });
});

describe('helpers', () => {
  it('GENPASS', () => {
    expect(genPass()).toMatch(/^[0-9a-f]{64}$/);
    expect(genPass('5')).toMatch(/^[0-9a-f]{2}$/);
    expect(genPass(4096)).toHaveLength(1024);
    expect(errorOf(() => genPass(0))).toBe(
      'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096',
    );
    expect(errorOf(() => genPass('x'))).toBe('ERR value is not an integer or out of range');
  });

  it('CAT', () => {
    const acl = makeAcl();
    expect(acl.categories()).toEqual([...ACL_CATEGORIES]);
    expect(acl.categories()).toHaveLength(21);
    expect(acl.commandsInCategory('ADMIN')).toEqual(['config|get', 'config|set', 'client|kill']);
    expect(errorOf(() => acl.commandsInCategory('nope'))).toBe("ERR Unknown category 'nope'");
  });

  it('GETUSER reply shape', () => {
    const acl = makeAcl();
    expect(acl.getUserReply('nobody')).toBeNull();
    expect(acl.getUserReply('default')).toBeTruthy();
  });
});
