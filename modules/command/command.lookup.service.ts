import { COMMAND_TABLE } from './command.meta_table';
import type { CommandLookup, CommandMeta, CommandSpec, MetaRow } from './command.types';

/**
 * Command metadata: builds the COMMAND table from `command.meta_table` (the Redis 7.0.15 table) once, on first use,
 * and looks commands and subcommands up in it (Redis lookupCommand(), arity checks).
 *
 * The implemented commands come from `command.registry`, which hands its map over with `useRegistry()` once it is built:
 * importing the registry from here would load every command module (and their imports of this module's facade) while
 * this class is still undefined.
 */
export default class CommandLookupService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static table: Map<string, CommandMeta> | null = null;

  private static commands: ReadonlyMap<string, CommandSpec> = new Map();

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static build(row: MetaRow, parent?: CommandMeta): CommandMeta {
    const fullname = parent ? `${parent.name}|${row.name}` : row.name;
    const meta: CommandMeta = {
      name: row.name,
      fullname,
      arity: row.arity,
      flags: row.flags,
      flagSet: new Set([...row.flags, ...(row.hidden ?? [])]),
      acl: row.acl,
      firstKey: row.keys[0],
      lastKey: row.keys[1],
      step: row.keys[2],
      tips: row.tips ?? [],
      keySpecs: row.keySpecs ?? [],
      subcommands: new Map(),
      group: row.group,
      since: row.since,
      summary: row.summary,
      complexity: row.complexity,
      docFlags: row.docFlags ?? [],
      deprecatedSince: row.deprecatedSince,
      replacedBy: row.replacedBy,
      history: row.history ?? [],
      args: row.args ?? [],
      parent,
    };
    for (const sub of row.subs ?? []) meta.subcommands.set(sub.name, CommandLookupService.build(sub, meta));
    return meta;
  }

  private static metaTable(): Map<string, CommandMeta> {
    if (CommandLookupService.table) return CommandLookupService.table;
    // only the commands redis-lite implements are reported (the registry keeps only the commands of the table)
    const out = new Map<string, CommandMeta>();
    for (const row of COMMAND_TABLE) if (CommandLookupService.commands.has(row.name)) out.set(row.name, CommandLookupService.build(row));
    CommandLookupService.table = out;
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Called by `command.registry` with every implemented command; the metadata table is rebuilt on next use. */
  static useRegistry(commands: ReadonlyMap<string, CommandSpec>): void {
    CommandLookupService.commands = commands;
    CommandLookupService.table = null;
  }

  /** Every implemented top-level command. */
  static allCommandMeta(): CommandMeta[] {
    return [...CommandLookupService.metaTable().values()];
  }

  /** Top-level command by name (case-insensitive), or `container|sub`. */
  static getCommandMeta(name: string): CommandMeta | undefined {
    const lower = name.toLowerCase();
    const bar = lower.indexOf('|');
    if (bar < 0) return CommandLookupService.metaTable().get(lower);
    return CommandLookupService.metaTable().get(lower.slice(0, bar))?.subcommands.get(lower.slice(bar + 1));
  }

  /** Redis lookupCommand(): the subcommand when the command is a container and a subcommand is given. */
  static lookupCommand(argv: string[]): CommandLookup {
    const base = CommandLookupService.getCommandMeta(argv[0]);
    if (!base || argv.length === 1 || !base.subcommands.size) return { meta: base, base };
    return { meta: base.subcommands.get(argv[1].toLowerCase()), base };
  }

  static arityOk(arity: number, argc: number): boolean {
    return arity > 0 ? argc === arity : argc >= -arity;
  }

  /** Every command and subcommand, depth first (COMMAND LIST, ACL CAT). */
  static allCommandsDeep(): CommandMeta[] {
    const out: CommandMeta[] = [];
    for (const m of CommandLookupService.allCommandMeta()) {
      out.push(m);
      out.push(...m.subcommands.values());
    }
    return out;
  }
}
