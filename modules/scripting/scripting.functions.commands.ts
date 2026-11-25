import { CommandError } from '@/libs/app-error';
import { RespMessages, unknownSubcommand } from '@/libs/resp/messages';
import type { Reply } from '@/libs/resp';
import { OK, RespMap, RespSet } from '@/libs/resp';
import { parseInteger } from '@/libs/number';
import { matchGlob } from '@/libs/glob';

import { functionsDumpPayload, functionsRestorePayload } from '@/modules/persistence/persistence.rdb';
import type { CommandContext, CommandSpec } from '@/modules/command/command.types';

function fcall(ctx: CommandContext, args: string[], readOnly = false): Reply {
  const n = parseInteger(args[1]);
  if (n < 0) throw new CommandError(RespMessages.NUMKEYS_NEGATIVE);
  if (n > args.length - 2) throw new CommandError(RespMessages.NUMKEYS_GREATER);
  return ctx.server.lua.callFunction(
    ctx.client,
    args[0],
    args.slice(2, 2 + n),
    args.slice(2 + n),
    readOnly,
  );
}

function fn(ctx: CommandContext, args: string[]): Reply {
  const lua = ctx.server.lua;
  const sub = args[0].toLowerCase();
  switch (sub) {
    case 'load': {
      const replace = args[1]?.toLowerCase() === 'replace';
      const code = args[replace ? 2 : 1];
      if (code === undefined || args.length > (replace ? 3 : 2))
        throw new CommandError(
          "ERR wrong number of arguments for 'function|load' command",
        );
      return lua.loadLibrary(code, replace);
    }
    case 'delete':
      if (!lua.deleteLibrary(args[1] ?? ''))
        throw new CommandError('ERR Library not found');
      return OK;
    case 'flush':
      for (const name of [...lua.libraries.keys()]) lua.deleteLibrary(name);
      return OK;
    case 'list': {
      let pattern = '*';
      let withCode = false;
      for (let i = 1; i < args.length; i++) {
        const opt = args[i].toLowerCase();
        if (opt === 'libraryname' && i + 1 < args.length) pattern = args[++i];
        else if (opt === 'withcode') withCode = true;
        else throw new CommandError(RespMessages.SYNTAX);
      }
      return [...lua.libraries.values()]
        .filter((lib) => matchGlob(pattern, lib.name))
        .map((lib) => {
          const entry: Reply[] = [
            'library_name',
            lib.name,
            'engine',
            'LUA',
            'functions',
            lib.functions.map((f) => {
              const meta = lib.meta.get(f);
              return RespMap.from([
                'name',
                f,
                'description',
                meta?.description ?? null,
                'flags',
                new RespSet(meta?.flags ?? []),
              ]);
            }),
          ];
          if (withCode) entry.push('library_code', lib.code);
          return RespMap.from(entry);
        });
    }
    case 'stats': {
      const libs = [...lua.libraries.values()];
      return RespMap.from([
        'running_script',
        null,
        'engines',
        RespMap.from([
          'LUA',
          RespMap.from([
            'libraries_count',
            libs.length,
            'functions_count',
            libs.reduce((n, l) => n + l.functions.length, 0),
          ]),
        ]),
      ]);
    }
    case 'dump':
      return functionsDumpPayload(
        [...lua.libraries.values()].map((l) => l.code),
      ).toString('latin1');
    case 'restore': {
      const payload = args[1] ?? '';
      const policy = (args[2] ?? 'append').toLowerCase();
      if (!['flush', 'append', 'replace'].includes(policy))
        throw new CommandError(
          'ERR Wrong restore policy given, value should be either FLUSH, APPEND or REPLACE.',
        );
      let codes: string[];
      try {
        codes = functionsRestorePayload(Buffer.from(payload, 'latin1'));
      } catch (error) {
        const msg = (error as Error).message;
        throw new CommandError(
          msg.includes('version or checksum')
            ? 'ERR payload version or checksum are wrong'
            : 'ERR given payload is not a valid function dump',
        );
      }
      if (policy === 'flush')
        for (const name of [...lua.libraries.keys()]) lua.deleteLibrary(name);
      for (const code of codes) lua.loadLibrary(code, policy === 'replace');
      return OK;
    }
    case 'kill':
      throw new CommandError('NOTBUSY No scripts in execution right now.');
    case 'help':
      return ['FUNCTION <subcommand>'];
    default:
      throw new CommandError(unknownSubcommand(args[0], 'function'));
  }
}

export const functionCommands: CommandSpec[] = [
  { name: 'function', arity: -2, flags: { noscript: true }, handler: fn },
  { name: 'fcall', arity: -3, flags: { noscript: true }, handler: fcall },
  {
    name: 'fcall_ro',
    arity: -3,
    flags: { noscript: true },
    handler: (ctx, args) => fcall(ctx, args, true),
  },
];
