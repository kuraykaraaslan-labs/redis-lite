import { describe, expect, it } from 'vitest';

import '@/modules/command/command.registry';

import CommandService from '../command.service';

/** Unit tests of the command metadata: lookup, arity, key extraction, help texts (no server). */

describe('lookupCommand', () => {
  it('finds commands case-insensitively and subcommands of containers', () => {
    expect(CommandService.lookupCommand(['GET', 'k']).meta?.fullname).toBe('get');
    expect(CommandService.lookupCommand(['client', 'LIST']).meta?.fullname).toBe('client|list');
    expect(CommandService.lookupCommand(['client']).meta?.fullname).toBe('client');
  });

  it('has no metadata for an unknown subcommand of a container', () => {
    const { meta, base } = CommandService.lookupCommand(['config', 'nosuch']);
    expect(meta).toBeUndefined();
    expect(base?.fullname).toBe('config');
  });
});

describe('arityOk', () => {
  it('checks exact and minimum arities', () => {
    expect(CommandService.arityOk(2, 2)).toBe(true);
    expect(CommandService.arityOk(2, 3)).toBe(false);
    expect(CommandService.arityOk(-2, 5)).toBe(true);
    expect(CommandService.arityOk(-3, 2)).toBe(false);
  });
});

describe('keyNames', () => {
  it('applies the key specs to a command line', () => {
    const mset = CommandService.getCommandMeta('mset');
    expect(mset && CommandService.keyNames(mset, ['MSET', 'a', '1', 'b', '2'])).toEqual(['a', 'b']);
    const sort = CommandService.getCommandMeta('sort');
    expect(sort && CommandService.keyNames(sort, ['SORT', 'src', 'LIMIT', '0', '1', 'STORE', 'dst'])).toEqual(['src', 'dst']);
  });
});

describe('subcommandSyntaxMessage', () => {
  it('quotes the subcommand as typed and names the container in capitals', () => {
    expect(CommandService.subcommandSyntaxMessage('GetUser', 'acl')).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'GetUser'. Try ACL HELP.",
    );
  });
});
