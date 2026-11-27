import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { EvalDTO, EvalShaDTO, FcallDTO, FunctionDTO, ScriptDTO } from '../scripting.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the scripting.*.service and scripting.*.engine tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('numkeys (EvalDTO, EvalShaDTO, FcallDTO)', () => {
  it('splits keys and arguments', () => {
    expect(parse(EvalDTO, ['return 1', '2', 'k1', 'k2', 'a1'])).toEqual({ script: 'return 1', keys: ['k1', 'k2'], argv: ['a1'] });
    expect(parse(EvalShaDTO, ['ABCDEF', '0', 'a1'])).toEqual({ sha: 'abcdef', keys: [], argv: ['a1'] });
    expect(parse(FcallDTO, ['fn', '1', 'k1'])).toEqual({ name: 'fn', keys: ['k1'], argv: [], numKeysError: null });
  });

  it('checks the integer first, then the sign, then the count', () => {
    expect(parse(EvalDTO, ['return 1', 'x'])).toBe('ERR value is not an integer or out of range');
    expect(parse(EvalDTO, ['return 1', '-1'])).toBe("ERR Number of keys can't be negative");
    expect(parse(EvalDTO, ['return 1', '2', 'k1'])).toBe("ERR Number of keys can't be greater than number of args");
    expect(parse(EvalDTO, ['return 1', '9223372036854775807'])).toBe("ERR Number of keys can't be greater than number of args");
    expect(parse(EvalDTO, ['return 1', '9223372036854775808'])).toBe('ERR value is not an integer or out of range');
  });

  it('FCALL hands a numkeys problem over (the function is looked up first)', () => {
    const error = (args: string[]) => (parse(FcallDTO, args) as { numKeysError: string | null }).numKeysError;
    expect(error(['fn', 'x'])).toBe('ERR Bad number of keys provided');
    expect(error(['fn', '-1'])).toBe("ERR Number of keys can't be negative");
    expect(error(['fn', '2', 'k1'])).toBe("ERR Number of keys can't be greater than number of args");
  });
});

describe('ScriptDTO', () => {
  it('parses subcommands case-insensitively', () => {
    expect(parse(ScriptDTO, ['LoAd', 'return 1'])).toEqual({ subcommand: 'load', script: 'return 1' });
    expect(parse(ScriptDTO, ['EXISTS', 'a', 'b'])).toEqual({ subcommand: 'exists', shas: ['a', 'b'] });
    expect(parse(ScriptDTO, ['flush', 'async'])).toEqual({ subcommand: 'flush', mode: 'async' });
    expect(parse(ScriptDTO, ['flush'])).toEqual({ subcommand: 'flush', mode: null });
    expect(parse(ScriptDTO, ['help'])).toEqual({ subcommand: 'help' });
  });

  it('rejects a wrong LOAD arity and unknown subcommands', () => {
    expect(parse(ScriptDTO, ['load'])).toBe("ERR wrong number of arguments for 'script|load' command");
    expect(parse(ScriptDTO, ['load', 'a', 'b'])).toBe("ERR wrong number of arguments for 'script|load' command");
    expect(parse(ScriptDTO, ['Nope'])).toBe("ERR unknown subcommand 'Nope'. Try SCRIPT HELP.");
  });

  it('FLUSH takes SYNC or ASYNC only', () => {
    expect(parse(ScriptDTO, ['flush', 'foo'])).toBe('ERR SCRIPT FLUSH only support SYNC|ASYNC option');
    expect(parse(ScriptDTO, ['flush', 'sync', 'async'])).toBe('ERR SCRIPT FLUSH only support SYNC|ASYNC option');
  });
});

describe('FunctionDTO', () => {
  it('LOAD with and without REPLACE', () => {
    expect(parse(FunctionDTO, ['load', 'code'])).toEqual({ subcommand: 'load', code: 'code', replace: false });
    expect(parse(FunctionDTO, ['LOAD', 'REPLACE', 'code'])).toEqual({ subcommand: 'load', code: 'code', replace: true });
    // the code is the last argument, every argument before it an option
    expect(parse(FunctionDTO, ['load', 'replace'])).toEqual({ subcommand: 'load', code: 'replace', replace: false });
    expect(parse(FunctionDTO, ['load', 'code', 'extra'])).toBe('ERR Unknown option given: code');
    expect(parse(FunctionDTO, ['load', 'FOO', 'code'])).toBe('ERR Unknown option given: FOO');
  });

  it('LIST options are read left to right', () => {
    expect(parse(FunctionDTO, ['list', 'WITHCODE', 'libraryname', 'a*'])).toEqual({ subcommand: 'list', pattern: 'a*', withCode: true });
    expect(parse(FunctionDTO, ['list', 'libraryname'])).toBe('ERR library name argument was not given');
    expect(parse(FunctionDTO, ['list', 'WITHCODE', 'withcode'])).toBe('ERR Unknown argument withcode');
    expect(parse(FunctionDTO, ['list', 'FOO'])).toBe('ERR Unknown argument FOO');
  });

  it('FLUSH takes SYNC or ASYNC only', () => {
    expect(parse(FunctionDTO, ['flush', 'SYNC'])).toEqual({ subcommand: 'flush', mode: 'sync' });
    expect(parse(FunctionDTO, ['flush', 'foo'])).toBe('ERR FUNCTION FLUSH only supports SYNC|ASYNC option');
    expect(parse(FunctionDTO, ['FLUSH', 'sync', 'async'])).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'FLUSH'. Try FUNCTION HELP.",
    );
  });

  it('RESTORE checks the policy, not the payload', () => {
    expect(parse(FunctionDTO, ['restore', 'payload'])).toEqual({ subcommand: 'restore', payload: 'payload', policy: 'append' });
    expect(parse(FunctionDTO, ['restore', 'payload', 'Replace'])).toEqual({ subcommand: 'restore', payload: 'payload', policy: 'replace' });
    expect(parse(FunctionDTO, ['restore', 'payload', 'merge'])).toBe(
      'ERR Wrong restore policy given, value should be either FLUSH, APPEND or REPLACE.',
    );
  });

  it('DELETE without a name and unknown subcommands', () => {
    expect(parse(FunctionDTO, ['delete'])).toEqual({ subcommand: 'delete', library: '' });
    expect(parse(FunctionDTO, ['nope'])).toBe("ERR unknown subcommand 'nope'. Try FUNCTION HELP.");
  });
});
