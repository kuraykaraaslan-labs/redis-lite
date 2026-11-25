import { describe, expect, it } from 'vitest';

import { firstIssue } from '@/libs/schemas';

import { ClientCachingDTO, ClientTrackingDTO } from '../tracking.dto';

const issue = (dto: typeof ClientTrackingDTO | typeof ClientCachingDTO, args: string[]): string | null => {
  const parsed = dto.safeParse(args);
  return parsed.success ? null : firstIssue(parsed.error);
};

describe('ClientTrackingDTO', () => {
  it('parses the mode and options case-insensitively', () => {
    expect(ClientTrackingDTO.parse(['On', 'redirect', '7', 'PREFIX', 'a', 'prefix', 'b', 'bcast', 'NOLOOP'])).toEqual({
      on: true,
      redirect: 7,
      bcast: true,
      optin: false,
      optout: false,
      noloop: true,
      prefixes: ['a', 'b'],
    });
    expect(ClientTrackingDTO.parse(['off']).on).toBe(false);
  });

  it('reports the first problem in argument order', () => {
    expect(issue(ClientTrackingDTO, ['maybe', 'redirect', 'x'])).toBe('ERR syntax error');
    expect(issue(ClientTrackingDTO, ['on', 'redirect', 'x', 'bogus'])).toBe('ERR value is not an integer or out of range');
    expect(issue(ClientTrackingDTO, ['on', 'bogus', 'redirect', 'x'])).toBe('ERR syntax error');
    // an option missing its value is unknown
    expect(issue(ClientTrackingDTO, ['on', 'redirect'])).toBe('ERR syntax error');
    expect(issue(ClientTrackingDTO, ['on', 'prefix'])).toBe('ERR syntax error');
  });
});

describe('ClientCachingDTO', () => {
  it('accepts YES / NO in any case', () => {
    expect(ClientCachingDTO.parse(['YES'])).toEqual({ value: 'yes' });
    expect(ClientCachingDTO.parse(['no'])).toEqual({ value: 'no' });
    expect(issue(ClientCachingDTO, ['maybe'])).toBe('ERR syntax error');
  });
});
