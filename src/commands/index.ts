import { bitmapCommands } from './bitmaps';
import { connectionCommands } from './connection';
import { functionCommands } from './functions';
import { geoCommands } from './geo';
import { hashCommands } from './hashes';
import { hyperloglogCommands } from './hyperloglog';
import { keyCommands } from './keys';
import { extraKeyCommands } from './keys-extra';
import { listCommands } from './lists';
import { pubsubCommands } from './pubsub';
import { scriptingCommands } from './scripting';
import { serverCommands } from './server';
import { setCommands } from './sets';
import { streamCommands } from './streams';
import { stringCommands } from './strings';
import { transactionCommands } from './transactions';
import type { CommandSpec } from './types';
import { zsetCommands } from './zsets';

/** Every supported command, by lowercase name. */
export const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map(
  [
    ...connectionCommands,
    ...serverCommands,
    ...keyCommands,
    ...extraKeyCommands,
    ...stringCommands,
    ...bitmapCommands,
    ...hashCommands,
    ...listCommands,
    ...setCommands,
    ...zsetCommands,
    ...streamCommands,
    ...hyperloglogCommands,
    ...geoCommands,
    ...pubsubCommands,
    ...transactionCommands,
    ...scriptingCommands,
    ...functionCommands,
  ].map((spec) => [spec.name, spec]),
);
