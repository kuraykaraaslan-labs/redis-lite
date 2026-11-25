import { z } from 'zod';

export const LogLevelEnum = z.enum(['silent', 'warn', 'info', 'debug']);

/** Options of `RedisLite.start()` and the CLI. */
export const RedisLiteOptionsSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(6379),
  host: z.string().min(1).default('127.0.0.1'),
  password: z.string().min(1).optional(),
  databases: z.coerce.number().int().min(1).max(256).default(16),
  logLevel: LogLevelEnum.default('warn'),
  /** Persistence. Giving any of dir / dbfilename / appendonly / save turns persistence on with Redis's defaults for the
   * rest (save points on, appendonly no); without them the server stays in memory. */
  dir: z.string().min(1).optional(),
  dbfilename: z.string().min(1).optional(),
  appendonly: z.union([z.boolean(), z.enum(['yes', 'no'])]).optional(),
  /** Save points, as in redis.conf: "3600 1 300 100 60 10000", or "" for none. */
  save: z.string().optional(),
  /** ACL file (loaded at startup, used by ACL LOAD / ACL SAVE). */
  aclfile: z.string().min(1).optional(),
  /** The redis.conf the values came from (INFO config_file). */
  configFile: z.string().min(1).optional(),
  /** Any other config directive (CONFIG SET names), applied at startup. */
  config: z.record(z.string(), z.string()).optional(),
});

export type RedisLiteOptions = z.input<typeof RedisLiteOptionsSchema>;
export type ResolvedOptions = z.output<typeof RedisLiteOptionsSchema>;

/** CLI defaults from the environment (flags win). The only place that reads process.env. */
export const EnvSchema = z.object({
  REDIS_LITE_PORT: z.string().optional(),
  REDIS_LITE_HOST: z.string().optional(),
  REDIS_LITE_PASSWORD: z.string().optional(),
  REDIS_LITE_LOG_LEVEL: LogLevelEnum.optional(),
  REDIS_LITE_DIR: z.string().optional(),
  REDIS_LITE_DBFILENAME: z.string().optional(),
  REDIS_LITE_APPENDONLY: z.enum(['yes', 'no']).optional(),
  REDIS_LITE_SAVE: z.string().optional(),
});

export function readEnv(): z.infer<typeof EnvSchema> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid REDIS_LITE_* environment: ${parsed.error.message}`);
  return parsed.data;
}
