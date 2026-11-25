import { createHash } from "node:crypto";

import { CommandError } from "../errors";
import { RespMessages, unknownSubcommand } from "../messages";
import type { Reply } from "../resp";
import { OK, RespError } from "../resp";
import { parseInteger } from "../util";
import type { CommandContext, CommandSpec } from "./types";

export function sha1hex(text: string): string {
  return createHash("sha1").update(Buffer.from(text, "latin1")).digest("hex");
}

function splitKeys(args: string[]): { keys: string[]; argv: string[] } {
  const n = parseInteger(args[1]);
  if (n < 0) throw new CommandError(RespMessages.NUMKEYS_NEGATIVE);
  if (n > args.length - 2) throw new CommandError(RespMessages.NUMKEYS_GREATER);
  return { keys: args.slice(2, 2 + n), argv: args.slice(2 + n) };
}

function run(
  ctx: CommandContext,
  sha: string,
  body: string,
  args: string[],
  readOnly = false,
): Reply {
  const { keys, argv } = splitKeys(args);
  return ctx.server.lua.run(ctx.client, sha, body, keys, argv, readOnly);
}

export const scriptingCommands: CommandSpec[] = [
  {
    name: "eval",
    arity: -3,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const sha = sha1hex(args[0]);
      ctx.server.scripts.set(sha, args[0]);
      return run(ctx, sha, args[0], args);
    },
  },
  {
    name: "evalsha",
    arity: -3,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const sha = args[0].toLowerCase();
      const body = ctx.server.scripts.get(sha);
      if (body === undefined) return new RespError(RespMessages.NOSCRIPT);
      return run(ctx, sha, body, args);
    },
  },
  {
    name: "eval_ro",
    arity: -3,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const sha = sha1hex(args[0]);
      ctx.server.scripts.set(sha, args[0]);
      return run(ctx, sha, args[0], args, true);
    },
  },
  {
    name: "evalsha_ro",
    arity: -3,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const body = ctx.server.scripts.get(args[0].toLowerCase());
      if (body === undefined) return new RespError(RespMessages.NOSCRIPT);
      return run(ctx, args[0].toLowerCase(), body, args, true);
    },
  },
  {
    name: "script",
    arity: -2,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const sub = args[0].toLowerCase();
      if (sub === "load") {
        if (args.length !== 2)
          throw new CommandError(
            "ERR wrong number of arguments for 'script|load' command",
          );
        const sha = sha1hex(args[1]);
        ctx.server.lua.compile(sha, args[1]);
        ctx.server.scripts.set(sha, args[1]);
        return sha;
      }
      if (sub === "exists")
        return args
          .slice(1)
          .map((sha) => (ctx.server.scripts.has(sha.toLowerCase()) ? 1 : 0));
      if (sub === "flush") {
        ctx.server.scripts.clear();
        ctx.server.lua.flush();
        return OK;
      }
      if (sub === "kill")
        throw new CommandError("NOTBUSY No scripts in execution right now.");
      throw new CommandError(unknownSubcommand(args[0], "script"));
    },
  },
];
