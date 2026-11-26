#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readEnv } from '@/libs/env';
import Logger from '@/libs/logger';

import { RedisLite } from '@/index';
import { configFileError, foldDirectives, readConfigFile } from '@/modules/server/server.conf_file';
import { CONFIG_DEFS, ServerConfig } from '@/modules/server/server.config';

const HELP = `redis-lite: Redis-compatible server (dev, CI and single-node use only)

Usage: redis-lite [/path/to/redis.conf] [options]

  -p, --port <n>           port to listen on (default 6379, env REDIS_LITE_PORT)
  -h, --host <addr>        address to bind (default 127.0.0.1, env REDIS_LITE_HOST)
      --password <pw>      require AUTH (env REDIS_LITE_PASSWORD)
      --databases <n>      number of databases (default 16)
      --dir <path>         working directory for RDB / AOF files (default: current directory, env REDIS_LITE_DIR)
      --dbfilename <name>  RDB file name (default dump.rdb, env REDIS_LITE_DBFILENAME)
      --appendonly yes|no  enable the append only file (default no, env REDIS_LITE_APPENDONLY)
      --save "<points>"    RDB save points, e.g. "3600 1 300 100" or "" to disable
                           (default "3600 1 300 100 60 10000", env REDIS_LITE_SAVE)
      --replicaof "<host> <port>"
                           start as a replica of that master (same as the replicaof directive)
      --log-level <lvl>    silent | warn | info | debug (default warn)
      --help               show this help

A redis.conf path may be given first: \`name value\` lines, quoted arguments, \`include\` and repeated \`save\` lines
are supported. Command-line options override the file, which overrides the environment.
`;

/** Redis's documented defaults for a server started from the command line. */
const DEFAULT_SAVE = '3600 1 300 100 60 10000';

/** Directives that become RedisLite options instead of plain config values. */
const OPTION_DIRECTIVES = new Set(['port', 'bind', 'requirepass', 'databases', 'aclfile', 'dir', 'dbfilename', 'appendonly', 'save']);

function loadConfigFile(path: string): Map<string, string> {
  const directives = readConfigFile(path);
  const probe = new ServerConfig({});
  const { values, unknown } = foldDirectives(directives, (name) => ServerConfig.canonical(name) in CONFIG_DEFS);
  for (const d of unknown) Logger.warn('[cli.loadConfigFile] Ignoring unsupported directive', { directive: d.name, file: d.file, line: d.line });
  for (const d of directives) {
    if (!(ServerConfig.canonical(d.name) in CONFIG_DEFS) || d.name === 'save' || d.name === 'bind') continue;
    const r = probe.validate(d.name, d.args.join(' '));
    if ('error' in r) throw configFileError(d, r.error);
  }
  return values;
}

/** `bind` may list several addresses (a leading '-' marks an optional one); the first is used. */
function bindHost(bind: string | undefined): string | undefined {
  if (!bind) return undefined;
  const first = bind.split(/\s+/).filter(Boolean)[0]?.replace(/^-/, '');
  if (!first) return undefined;
  return first === '*' ? '0.0.0.0' : first;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'h' },
      password: { type: 'string' },
      databases: { type: 'string' },
      dir: { type: 'string' },
      dbfilename: { type: 'string' },
      appendonly: { type: 'string' },
      save: { type: 'string' },
      replicaof: { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length > 1) throw new Error(`unexpected arguments: ${positionals.slice(1).join(' ')}`);
  const env = readEnv();
  const configFile = positionals[0] ? resolve(positionals[0]) : undefined;
  const file = configFile ? loadConfigFile(configFile) : new Map<string, string>();
  if (values.appendonly !== undefined && values.appendonly !== 'yes' && values.appendonly !== 'no') {
    throw new Error("--appendonly must be 'yes' or 'no'");
  }
  const config: Record<string, string> = {};
  for (const [name, value] of file) if (!OPTION_DIRECTIVES.has(ServerConfig.canonical(name))) config[name] = value;
  if (values.replicaof !== undefined) {
    const checked = new ServerConfig({}).validate('replicaof', values.replicaof);
    if ('error' in checked) throw new Error(`--replicaof: ${checked.error}`);
    delete config.slaveof;
    config.replicaof = checked.value;
  }

  const server = await RedisLite.start({
    port: values.port ?? file.get('port') ?? env.REDIS_LITE_PORT ?? 6379,
    host: values.host ?? bindHost(file.get('bind')) ?? env.REDIS_LITE_HOST ?? '127.0.0.1',
    password: values.password ?? (file.get('requirepass') || undefined) ?? env.REDIS_LITE_PASSWORD,
    databases: values.databases ?? file.get('databases') ?? 16,
    aclfile: file.get('aclfile') || undefined,
    logLevel: (values['log-level'] ?? env.REDIS_LITE_LOG_LEVEL ?? 'warn') as 'warn',
    dir: values.dir ?? file.get('dir') ?? env.REDIS_LITE_DIR ?? process.cwd(),
    dbfilename: values.dbfilename ?? file.get('dbfilename') ?? env.REDIS_LITE_DBFILENAME ?? 'dump.rdb',
    appendonly: (values.appendonly ?? file.get('appendonly') ?? env.REDIS_LITE_APPENDONLY ?? 'no') === 'yes',
    save: values.save ?? file.get('save') ?? env.REDIS_LITE_SAVE ?? DEFAULT_SAVE,
    configFile,
    config,
  });
  process.stdout.write(
    `redis-lite listening on ${server.url}\n` +
      'Single process: for dev, CI and single-node use. Not a production Redis.\n',
  );
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.onClose(() => process.exit(0));
}

main().catch((error: unknown) => {
  Logger.error('[cli.main] Startup failed', { err: (error as Error).message });
  process.exit(1);
});
