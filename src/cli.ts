#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { RedisLite } from './index';
import { readEnv } from './libs/env';

const HELP = `redis-lite: minimal in-memory Redis-compatible server (dev, CI and single-node use only)

Usage: redis-lite [options]

  -p, --port <n>         port to listen on (default 6379, env REDIS_LITE_PORT)
  -h, --host <addr>      address to bind (default 127.0.0.1, env REDIS_LITE_HOST)
      --password <pw>    require AUTH (env REDIS_LITE_PASSWORD)
      --databases <n>    number of databases (default 16)
      --log-level <lvl>  silent | warn | info | debug (default warn)
      --help             show this help
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'h' },
      password: { type: 'string' },
      databases: { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const env = readEnv();
  const server = await RedisLite.start({
    port: values.port ?? env.REDIS_LITE_PORT ?? 6379,
    host: values.host ?? env.REDIS_LITE_HOST ?? '127.0.0.1',
    password: values.password ?? env.REDIS_LITE_PASSWORD,
    databases: values.databases ?? 16,
    logLevel: (values['log-level'] ?? env.REDIS_LITE_LOG_LEVEL ?? 'warn') as 'warn',
  });
  process.stdout.write(
    `redis-lite listening on ${server.url}\n` +
      'In-memory only, single process: for dev, CI and single-node use. Not a production Redis.\n',
  );
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`redis-lite: ${(error as Error).message}\n`);
  process.exit(1);
});
