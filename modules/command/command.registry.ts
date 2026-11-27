import { bitmapCommands } from '@/modules/bitmaps/bitmaps.commands';
import { connectionCommands } from '@/modules/connection/connection.commands';
import { functionCommands } from '@/modules/scripting/scripting.functions.commands';
import { geoCommands } from '@/modules/geo/geo.commands';
import { hashCommands } from '@/modules/hashes/hashes.commands';
import { hyperloglogCommands } from '@/modules/hyperloglog/hyperloglog.commands';
import { keyCommands } from '@/modules/keys/keys.commands';
import { extraKeyCommands } from '@/modules/keys/keys.extra.commands';
import { listCommands } from '@/modules/lists/lists.commands';
import { pubsubCommands } from '@/modules/pubsub/pubsub.commands';
import { replicationCommands } from '@/modules/replication/replication.commands';
import { scriptingCommands } from '@/modules/scripting/scripting.commands';
import { serverCommands } from '@/modules/server/server.commands';
import { setCommands } from '@/modules/sets/sets.commands';
import { streamCommands } from '@/modules/streams/streams.commands';
import { stringCommands } from '@/modules/strings/strings.commands';
import { transactionCommands } from '@/modules/transactions/transactions.commands';
import { zsetCommands } from '@/modules/zsets/zsets.commands';

import CommandLookupService from './command.lookup.service';
import { COMMAND_TABLE } from './command.meta_table';
import type { CommandSpec } from './command.types';

/** The commands of the target's table: a handler without a table row is not served (it answers like an unknown command). */
const TABLE_NAMES = new Set(COMMAND_TABLE.map((row) => row.name));

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
    ...replicationCommands,
  ]
    .filter((spec) => TABLE_NAMES.has(spec.name))
    .map((spec) => [spec.name, spec]),
);

// the metadata lookup reads the implemented commands from here (see CommandLookupService.useRegistry)
CommandLookupService.useRegistry(COMMANDS);
