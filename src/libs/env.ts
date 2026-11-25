import { z } from 'zod';

export const LogLevelEnum = z.enum(['silent', 'warn', 'info', 'debug']);

/** Options of `RedisLite.start()` and the CLI. */
export const RedisLiteOptionsSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(6379),
  host: z.string().min(1).default('127.0.0.1'),
  password: z.string().min(1).optional(),
  databases: z.coerce.number().int().min(1).max(256).default(16),
  logLevel: LogLevelEnum.default('warn'),
});

export type RedisLiteOptions = z.input<typeof RedisLiteOptionsSchema>;
export type ResolvedOptions = z.output<typeof RedisLiteOptionsSchema>;

/** CLI defaults from the environment (flags win). The only place that reads process.env. */
export const EnvSchema = z.object({
  REDIS_LITE_PORT: z.string().optional(),
  REDIS_LITE_HOST: z.string().optional(),
  REDIS_LITE_PASSWORD: z.string().optional(),
  REDIS_LITE_LOG_LEVEL: LogLevelEnum.optional(),
});

export function readEnv(): z.infer<typeof EnvSchema> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid REDIS_LITE_* environment: ${parsed.error.message}`);
  return parsed.data;
}
