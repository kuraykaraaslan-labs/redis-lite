import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import {
  AclLogDTO,
  ConfigSetDTO,
  DebugPopulateDTO,
  LolwutDTO,
  MemoryUsageDTO,
  ShutdownDTO,
  SlowlogGetDTO,
  WaitAofDTO,
  WaitDTO,
} from '../server.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the server.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('CONFIG / ACL / SLOWLOG / MEMORY', () => {
  it('CONFIG SET needs name / value pairs', () => {
    expect(parse(ConfigSetDTO, ['set', 'a', '1', 'b'])).toBe("ERR wrong number of arguments for 'config|set' command");
    expect(parse(ConfigSetDTO, ['set', 'a', '1'])).toEqual({ pairs: [['a', '1']] });
  });

  it('ACL LOG takes a count or RESET', () => {
    expect(parse(AclLogDTO, ['log', '-5'])).toEqual({ reset: false, count: 0 });
    expect(parse(AclLogDTO, ['log', 'Reset'])).toEqual({ reset: true, count: 0 });
    expect(parse(AclLogDTO, ['LOG', '1', '2'])).toBe("ERR unknown subcommand or wrong number of arguments for 'LOG'. Try ACL HELP.");
  });

  it('SLOWLOG GET counts from -1', () => {
    expect(parse(SlowlogGetDTO, ['get'])).toEqual({ count: 10 });
    expect(parse(SlowlogGetDTO, ['get', '-2'])).toBe('ERR count should be greater than or equal to -1');
  });

  it('MEMORY USAGE reads SAMPLES', () => {
    expect(parse(MemoryUsageDTO, ['usage', 'k', 'SAMPLES', '0'])).toEqual({ key: 'k', samples: 0 });
    expect(parse(MemoryUsageDTO, ['usage', 'k', 'samples', '-1'])).toBe('ERR syntax error');
    expect(parse(MemoryUsageDTO, ['usage', 'k', 'samples'])).toBe('ERR syntax error');
  });
});

describe('admin DTOs', () => {
  it('WAIT and WAITAOF check the timeout first', () => {
    expect(parse(WaitDTO, ['x', '-1'])).toBe('ERR timeout is negative');
    expect(parse(WaitDTO, ['x', '0'])).toBe('ERR value is not an integer or out of range');
    expect(parse(WaitAofDTO, ['-1', 'x', 'y'])).toBe('ERR timeout is not an integer or out of range');
    expect(parse(WaitAofDTO, ['-1', 'x', '0'])).toBe('ERR value is out of range, must be positive');
  });

  it('SHUTDOWN refuses conflicting options', () => {
    expect(parse(ShutdownDTO, ['SAVE', 'nosave'])).toBe('ERR syntax error');
    expect(parse(ShutdownDTO, ['abort', 'now'])).toBe('ERR syntax error');
    expect(parse(ShutdownDTO, ['NOW', 'force'])).toEqual({ save: false, nosave: false, now: true, force: true, abort: false });
  });

  it('DEBUG POPULATE checks the count before the size', () => {
    expect(parse(DebugPopulateDTO, ['populate', '-1', 'p', 'x'])).toBe('ERR value is out of range, must be positive');
    expect(parse(DebugPopulateDTO, ['populate', '3'])).toEqual({ count: 3, prefix: 'key', size: 0 });
  });

  it('LOLWUT parses the art options of version 5 only', () => {
    expect(parse(LolwutDTO, ['version', '6', 'x'])).toEqual({ version: 6, cols: 0, perRow: 0, perCol: 0 });
    expect(parse(LolwutDTO, ['version', '5', 'x'])).toBe('ERR value is not an integer or out of range');
    expect(parse(LolwutDTO, ['version', '5', '5000', '0'])).toEqual({ version: 5, cols: 1000, perRow: 1, perCol: 12 });
  });
});
