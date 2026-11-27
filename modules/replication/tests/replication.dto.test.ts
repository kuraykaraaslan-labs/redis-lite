/**
 * Unit tests of the replication commands' argument grammar (replication.dto): parsed shapes and which error wins.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { FailoverDTO, PsyncDTO, ReplconfDTO, ReplicaOfDTO } from '../replication.dto';

function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('REPLICAOF', () => {
  it('host port, or NO ONE in any case', () => {
    expect(parse(ReplicaOfDTO, ['10.0.0.1', '6380'])).toEqual({ noOne: false, host: '10.0.0.1', port: 6380 });
    expect(parse(ReplicaOfDTO, ['No', 'oNe'])).toEqual({ noOne: true });
    expect(parse(ReplicaOfDTO, ['host', 'x'])).toBe('ERR value is not an integer or out of range');
  });
});

describe('PSYNC', () => {
  it('replid, integer offset, optional FAILOVER', () => {
    expect(parse(PsyncDTO, ['?', '-1'])).toEqual({ replid: '?', offset: '-1', failover: false });
    expect(parse(PsyncDTO, ['abc', '10', 'failover'])).toEqual({ replid: 'abc', offset: '10', failover: true });
    expect(parse(PsyncDTO, ['abc', 'ten'])).toBe('ERR value is not an integer or out of range');
    expect(parse(PsyncDTO, ['abc', '1', 'other'])).toBe('ERR syntax error');
  });
});

describe('REPLCONF', () => {
  it('options come in pairs and must be known; ACK ends the command', () => {
    expect(parse(ReplconfDTO, ['capa', 'eof', 'capa', 'psync2'])).toEqual({
      pairs: [
        { option: 'capa', value: 'eof' },
        { option: 'capa', value: 'psync2' },
      ],
    });
    expect(parse(ReplconfDTO, ['ACK', '100', 'FACK', '90'])).toEqual({ pairs: [{ option: 'ack', value: '100' }] });
    expect(parse(ReplconfDTO, ['listening-port'])).toBe('ERR syntax error');
    expect(parse(ReplconfDTO, ['bogus', '1'])).toBe('ERR Unrecognized REPLCONF option: bogus');
  });
});

describe('FAILOVER', () => {
  it('TO host port [FORCE], TIMEOUT, ABORT alone', () => {
    expect(parse(FailoverDTO, [])).toEqual({ abort: false, host: null, port: null, force: false, timeoutMs: 0 });
    expect(parse(FailoverDTO, ['to', 'h', '6380', 'FORCE', 'timeout', '50'])).toEqual({
      abort: false,
      host: 'h',
      port: 6380,
      force: true,
      timeoutMs: 50,
    });
    expect(parse(FailoverDTO, ['ABORT'])).toEqual({ abort: true, host: null, port: null, force: false, timeoutMs: 0 });
    expect(parse(FailoverDTO, ['ABORT', 'TIMEOUT', '5'])).toBe('ERR syntax error');
    expect(parse(FailoverDTO, ['TIMEOUT', '-1'])).toBe('ERR FAILOVER timeout must be greater than 0');
    expect(parse(FailoverDTO, ['TO', 'h'])).toBe('ERR syntax error');
    expect(parse(FailoverDTO, ['TIMEOUT', '1', 'TIMEOUT', '2'])).toBe('ERR syntax error');
  });
});
