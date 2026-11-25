import { describe, expect, it } from 'vitest';

import { AppError } from '@/libs/app-error';

import { AclCategoryEnum } from '../acl.enums';
import AclService from '../acl.service';
import { errorOf, FOO_HASH, makeAcl } from './acl.fixtures';

/** The ACL rule language (SETUSER, the default user, passwords, the users.acl file) and the ACL helpers. */

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
    expect(() => a.setUser('x', ['off', '+set', '+nosuch'])).toThrow(AppError);
    expect(a.describe('x')).toBe('user x on sanitize-payload resetchannels -@all +get');
    expect(() => a.setUser('y', ['+nosuch'])).toThrow(AppError);
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
    expect(AclService.hashPassword('foo')).toBe(FOO_HASH);
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
    expect(AclService.genPass()).toMatch(/^[0-9a-f]{64}$/);
    expect(AclService.genPass('5')).toMatch(/^[0-9a-f]{2}$/);
    expect(AclService.genPass(4096)).toHaveLength(1024);
    expect(errorOf(() => AclService.genPass(0))).toBe(
      'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096',
    );
    expect(errorOf(() => AclService.genPass('x'))).toBe('ERR value is not an integer or out of range');
  });

  it('CAT', () => {
    const acl = makeAcl();
    expect(acl.categories()).toEqual([...AclCategoryEnum.options]);
    expect(acl.categories()).toHaveLength(22);
    expect(acl.commandsInCategory('ADMIN')).toEqual(['config|get', 'config|set', 'client|kill']);
    expect(errorOf(() => acl.commandsInCategory('nope'))).toBe("ERR Unknown category 'nope'");
  });

  it('GETUSER reply shape', () => {
    const acl = makeAcl();
    expect(acl.getUserReply('nobody')).toBeNull();
    expect(acl.getUserReply('default')).toBeTruthy();
  });
});
