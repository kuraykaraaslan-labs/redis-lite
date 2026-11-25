import type { RedisLiteOptions } from './libs/env';
import { RedisLiteOptionsSchema } from './libs/env';
import { RedisLiteServer } from './server/server';

export type { RedisLiteOptions } from './libs/env';

/** A running redis-lite server. Point any Redis client at `url`. */
export class RedisLite {
  private constructor(
    private readonly server: RedisLiteServer,
    readonly host: string,
    readonly port: number,
  ) {}

  /** Starts a server. `port: 0` picks a free port (handy for tests). */
  static async start(options: RedisLiteOptions = {}): Promise<RedisLite> {
    const parsed = RedisLiteOptionsSchema.safeParse(options);
    if (!parsed.success) throw new Error(`Invalid redis-lite options: ${parsed.error.message}`);
    const { dir, dbfilename, appendonly, save, aclfile, config: extra, ...base } = parsed.data;
    const config: Record<string, string> = { ...extra };
    if (dir !== undefined) config.dir = dir;
    if (dbfilename !== undefined) config.dbfilename = dbfilename;
    if (appendonly !== undefined) config.appendonly = appendonly === true || appendonly === 'yes' ? 'yes' : 'no';
    if (save !== undefined) config.save = save;
    const persistence = ['dir', 'dbfilename', 'appendonly', 'save'].some((k) => k in config);
    const server = new RedisLiteServer({ ...base, aclfile, persistence, config });
    const address = await server.listen();
    server.options.port = address.port;
    return new RedisLite(server, parsed.data.host, address.port);
  }

  get url(): string {
    const auth = this.server.options.password ? `:${encodeURIComponent(this.server.options.password)}@` : '';
    return `redis://${auth}${this.host}:${this.port}`;
  }

  /** Runs `listener` once the server has stopped (close() or a client's SHUTDOWN). */
  onClose(listener: () => void): void {
    this.server.onClose(listener);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}
