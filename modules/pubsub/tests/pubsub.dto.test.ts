import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { PubSubDTO } from '../pubsub.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by pubsub.service.test.ts.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('PubSubDTO', () => {
  it('unknown subcommand, then arity, then the CHANNELS pattern count', () => {
    expect(parse(PubSubDTO, ['Foo'])).toBe("ERR unknown subcommand 'Foo'. Try PUBSUB HELP.");
    expect(parse(PubSubDTO, ['NUMPAT', 'x'])).toBe("ERR wrong number of arguments for 'pubsub|numpat' command");
    expect(parse(PubSubDTO, ['Channels', 'a', 'b'])).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'Channels'. Try PUBSUB HELP.",
    );
  });

  it('defaults the pattern to *', () => {
    expect(parse(PubSubDTO, ['channels'])).toEqual({ subcommand: 'channels', pattern: '*', channels: [] });
    expect(parse(PubSubDTO, ['NUMSUB', 'a', 'b'])).toEqual({ subcommand: 'numsub', pattern: 'a', channels: ['a', 'b'] });
  });
});
