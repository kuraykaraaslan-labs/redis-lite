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
    const server = new RedisLiteServer(parsed.data);
    const address = await server.listen();
    server.options.port = address.port;
    return new RedisLite(server, parsed.data.host, address.port);
  }

  get url(): string {
    const auth = this.server.options.password ? `:${encodeURIComponent(this.server.options.password)}@` : '';
    return `redis://${auth}${this.host}:${this.port}`;
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}
