import { describe, expect, it } from 'vitest';

import AclService from '../acl.service';
import { errorOf, makeAcl, r, rw, w } from './acl.fixtures';

/** Permission checks, denial texts and glob matching. */

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
    expect(AclService.noPermError({ reason: 'command', object: 'config|get' })).toBe(
      "NOPERM this user has no permissions to run the 'config|get' command",
    );
    expect(AclService.noPermError({ reason: 'key', object: 'k' })).toBe(
      'NOPERM this user has no permissions to access one of the keys used as arguments',
    );
    expect(AclService.noPermError({ reason: 'channel', object: 'c' })).toBe(
      'NOPERM this user has no permissions to access one of the channels used as arguments',
    );
    expect(AclService.denialMessage({ reason: 'key', object: 'k' }, 'verbose')).toBe("This user has no permissions to access the 'k' key");
    expect(AclService.denialMessage({ reason: 'channel', object: 'c' }, 'verbose')).toBe(
      "This user has no permissions to access the 'c' channel",
    );
    expect(AclService.denialMessage({ reason: 'command', object: 'del' }, 'script')).toBe(
      "The user executing the script can't run this command or subcommand",
    );
  });

  it('dryRun', () => {
    const acl = makeAcl();
    acl.setUser('u', ['+get', '~a']);
    expect(acl.dryRun('u', 'get', null, ['a'], [r('a')])).toBeNull();
    expect(acl.dryRun('u', 'get', null, ['b'], [r('b')])).toBe("This user has no permissions to access the 'b' key");
    expect(acl.dryRun('u', 'set', null, ['a', 'v'], [w('a')])).toBe("This user has no permissions to run the 'set' command");
    expect(errorOf(() => acl.dryRun('nobody', 'get', null, []))).toBe("ERR User 'nobody' not found");
  });
});

describe('glob matching', () => {
  it('follows stringmatchlen', () => {
    expect(AclService.globMatch('a*', 'abc')).toBe(true);
    expect(AclService.globMatch('a?c', 'abc')).toBe(true);
    expect(AclService.globMatch('a[bx]c', 'axc')).toBe(true);
    expect(AclService.globMatch('a[^b]c', 'abc')).toBe(false);
    expect(AclService.globMatch('a[a-c]', 'ab')).toBe(true);
    expect(AclService.globMatch('a\\*', 'a*')).toBe(true);
    expect(AclService.globMatch('a\\*', 'ab')).toBe(false);
    expect(AclService.globMatch('*', '')).toBe(false); // stringmatchlen quirk: empty string never enters the loop
    expect(AclService.globMatch('', '')).toBe(true);
    expect(AclService.globMatch('a', '')).toBe(false);
  });
});
