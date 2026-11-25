import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { AuthDTO, ClientKillDTO, ClientListDTO, ClientPauseDTO, ClientSetInfoDTO, ClientUnblockDTO, HelloDTO, PingDTO } from '../connection.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the connection.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('PingDTO / AuthDTO', () => {
  it('PING takes at most one message', () => {
    expect(parse(PingDTO, [])).toEqual({ message: undefined });
    expect(parse(PingDTO, ['a', 'b'])).toBe("ERR wrong number of arguments for 'ping' command");
  });

  it('AUTH without a username means the default user; more than two arguments is a syntax error', () => {
    expect(parse(AuthDTO, ['pw'])).toEqual({ username: null, password: 'pw' });
    expect(parse(AuthDTO, ['u', 'pw'])).toEqual({ username: 'u', password: 'pw' });
    expect(parse(AuthDTO, ['u', 'pw', 'x'])).toBe('ERR syntax error');
  });
});

describe('HelloDTO', () => {
  it('checks the protocol version before the options', () => {
    expect(parse(HelloDTO, ['x', 'bogus'])).toBe('ERR Protocol version is not an integer or out of range');
    expect(parse(HelloDTO, ['4', 'bogus'])).toBe('NOPROTO unsupported protocol version');
  });

  it('reads the options left to right', () => {
    expect(parse(HelloDTO, ['3', 'SETNAME', 'bad name', 'bogus'])).toBe(
      'ERR Client names cannot contain spaces, newlines or special characters.',
    );
    expect(parse(HelloDTO, ['3', 'bogus', 'SETNAME', 'bad name'])).toBe("ERR Syntax error in HELLO option 'bogus'");
    expect(parse(HelloDTO, ['2', 'auth', 'u', 'p', 'setname', 'n'])).toEqual({
      protocol: 2,
      auth: { username: 'u', password: 'p' },
      name: 'n',
    });
  });
});

describe('CLIENT DTOs', () => {
  it('SETINFO checks the attribute before its value', () => {
    expect(parse(ClientSetInfoDTO, ['setinfo', 'LIB-X', 'a b'])).toBe("ERR Unrecognized option 'LIB-X'");
    expect(parse(ClientSetInfoDTO, ['setinfo', 'LIB-NAME', 'a b'])).toBe('ERR LIB-NAME cannot contain spaces, newlines or special characters.');
  });

  it('LIST parses TYPE and ID filters', () => {
    expect(parse(ClientListDTO, ['list', 'type', 'SLAVE'])).toEqual({ type: 'replica', ids: null });
    expect(parse(ClientListDTO, ['list', 'id', '1', 'x'])).toBe('ERR Invalid client ID');
    expect(parse(ClientListDTO, ['list', 'bogus'])).toBe('ERR syntax error');
  });

  it('KILL hands a grammar error found after USER options to the service', () => {
    expect(parse(ClientKillDTO, ['kill', '1.2.3.4:5'])).toEqual({ address: '1.2.3.4:5', filters: null, error: null });
    expect(parse(ClientKillDTO, ['kill', 'user', 'u1', 'id', '0'])).toMatchObject({
      filters: { users: ['u1'] },
      error: 'ERR client-id should be greater than 0',
    });
  });

  it('UNBLOCK and PAUSE check the argument count first', () => {
    expect(parse(ClientUnblockDTO, ['UNBLOCK', 'x', 'y', 'z'])).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'UNBLOCK'. Try CLIENT HELP.",
    );
    expect(parse(ClientUnblockDTO, ['unblock', 'x', 'bogus'])).toBe('ERR CLIENT UNBLOCK reason should be TIMEOUT or ERROR');
    expect(parse(ClientPauseDTO, ['pause', '-1', 'bogus'])).toBe('ERR timeout is negative');
    expect(parse(ClientPauseDTO, ['pause', 'x'])).toBe('ERR timeout is not an integer or out of range');
  });
});
