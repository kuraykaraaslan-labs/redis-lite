import Redis from 'ioredis';
import { describe, expect, it } from 'vitest';

import { useServer, waitFor } from '@/tests/helpers';

/**
 * Busy scripts on a running server: a script that runs past busy-reply-threshold yields to the event loop, other clients
 * get BUSY, and SCRIPT KILL / FUNCTION KILL stop it (Redis's documented behaviour for long-running scripts).
 */
const t = useServer({ config: { 'busy-reply-threshold': '100' } });

describe('busy scripts', () => {
  it('other clients get BUSY and SCRIPT KILL ends the script', async () => {
    const looping = t.client();
    const result = looping.eval('while true do end', 0).then(
      () => 'returned',
      (e: Error) => e.message,
    );
    const other = t.client();
    // once the threshold has passed, ordinary commands are refused with BUSY
    await waitFor(async () => (await other.ping().catch((e: Error) => e.message)).startsWith('BUSY'), { timeout: 20_000 });
    expect(await other.call('SCRIPT', 'KILL')).toBe('OK');
    expect(await result).toMatch(/^ERR Script killed by user with SCRIPT KILL/);
    expect(await other.ping()).toBe('PONG');
  });

  it('SCRIPT KILL with nothing running answers NOTBUSY', async () => {
    await expect(t.call('SCRIPT', 'KILL')).rejects.toThrow(/^NOTBUSY/);
  });

  it('a script that wrote cannot be killed, SHUTDOWN NOSAVE is still allowed', async () => {
    // clients that do not reconnect: the server goes away at the end of this test
    const once = { maxRetriesPerRequest: 1, retryStrategy: (): null => null };
    const looping = new Redis(t.server.url, once);
    const other = new Redis(t.server.url, once);
    void looping.eval("redis.call('SET', 'busy:k', '1') while true do end", 0).catch(() => undefined);
    await waitFor(async () => (await other.ping().catch((e: Error) => e.message)).startsWith('BUSY'), { timeout: 20_000 });
    await expect(other.call('SCRIPT', 'KILL')).rejects.toThrow(/^UNKILLABLE/);
    const closed = new Promise<void>((resolve) => t.server.onClose(resolve));
    await other.call('SHUTDOWN', 'NOSAVE').catch(() => undefined);
    await closed;
    looping.disconnect();
    other.disconnect();
  });
});
