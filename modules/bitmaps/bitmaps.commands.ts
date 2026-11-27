import { keysAt, validated, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  BitCountDTO,
  BitfieldCmdDTO,
  BitfieldRoDTO,
  BitOpDTO,
  BitPosBitDTO,
  BitPosDTO,
  GetBitDTO,
  SetBitDTO,
} from './bitmaps.dto';
import BitmapsService from './bitmaps.service';

/**
 * Routing of the bitmap commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 * Several commands read their key BEFORE parsing their arguments, because Redis does (a WRONGTYPE beats a bad
 * argument): they call the service's read step, then `validated()`, then the service with the bytes already read.
 */

const WRITE = { write: true } as const;

export const bitmapCommands: CommandSpec[] = [
  {
    name: 'getbit',
    arity: 3,
    // read first: WRONGTYPE beats a bad offset
    handler: (ctx, args) => {
      const bytes = BitmapsService.read(ctx, args[0]);
      return validated(GetBitDTO, args, (input) => BitmapsService.getBit(ctx, bytes, input));
    },
  },
  { name: 'setbit', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(SetBitDTO, BitmapsService.setBit) },
  {
    name: 'bitcount',
    arity: -2,
    // read first: WRONGTYPE beats a bad range, and a missing key answers 0 without parsing the range
    handler: (ctx, args) => {
      const bytes = BitmapsService.readExisting(ctx, args[0]);
      if (bytes === null) return 0;
      return validated(BitCountDTO, args, (input) => BitmapsService.bitCount(bytes, input));
    },
  },
  {
    name: 'bitpos',
    arity: -3,
    // the bit first, then the key (WRONGTYPE), then the range; a missing key answers without parsing the range
    handler: (ctx, args) =>
      validated(BitPosBitDTO, args, (bitInput) => {
        const bytes = BitmapsService.readExisting(ctx, bitInput.key);
        if (bytes === null) return BitmapsService.bitPosMissing(bitInput);
        return validated(BitPosDTO, args, (input) => BitmapsService.bitPos(bytes, input));
      }),
  },
  { name: 'bitop', arity: -4, flags: WRITE, keys: keysAt(1), handler: withDTO(BitOpDTO, BitmapsService.bitOp) },
  {
    name: 'bitfield',
    arity: -2,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats a bad subcommand
    handler: (ctx, args) => {
      const bytes = BitmapsService.read(ctx, args[0]);
      return validated(BitfieldCmdDTO, args, (input) => BitmapsService.bitfield(ctx, bytes, input));
    },
  },
  {
    name: 'bitfield_ro',
    arity: -2,
    // read first: WRONGTYPE beats a bad subcommand
    handler: (ctx, args) => {
      const bytes = BitmapsService.read(ctx, args[0]);
      return validated(BitfieldRoDTO, args, (input) => BitmapsService.bitfield(ctx, bytes, input));
    },
  },
];
