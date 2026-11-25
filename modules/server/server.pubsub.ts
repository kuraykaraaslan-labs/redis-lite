import { matchGlob } from '@/libs/glob';
import { RespPush } from '@/libs/resp';

import type { Client } from './server.client';
import type { RedisLiteServer } from './server.core';

/** Pub/sub fan-out: the subscriber maps (channels, patterns, shard channels) and message delivery. */
export class ServerPubSub {
  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private removeSubscriber(map: Map<string, Set<Client>>, channel: string, client: Client): void {
    const set = map.get(channel);
    if (!set) return;
    set.delete(client);
    if (!set.size) map.delete(channel);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  subscribe(client: Client, channel: string, pattern: boolean): void {
    const map = pattern ? this.server.patterns : this.server.channels;
    let set = map.get(channel);
    if (!set) map.set(channel, (set = new Set()));
    set.add(client);
    (pattern ? client.patterns : client.channels).add(channel);
  }

  unsubscribe(client: Client, channel: string, pattern: boolean): void {
    this.removeSubscriber(pattern ? this.server.patterns : this.server.channels, channel, client);
    (pattern ? client.patterns : client.channels).delete(channel);
  }

  ssubscribe(client: Client, channel: string): void {
    const map = this.server.shardChannels;
    let set = map.get(channel);
    if (!set) map.set(channel, (set = new Set()));
    set.add(client);
    client.shardChannels.add(channel);
  }

  sunsubscribe(client: Client, channel: string): void {
    this.removeSubscriber(this.server.shardChannels, channel, client);
    client.shardChannels.delete(channel);
  }

  /** A closed connection leaves every subscriber map (its own sets are left as they are) and the monitors. */
  forget(client: Client): void {
    for (const ch of client.channels) this.removeSubscriber(this.server.channels, ch, client);
    for (const p of client.patterns) this.removeSubscriber(this.server.patterns, p, client);
    for (const ch of client.shardChannels) this.removeSubscriber(this.server.shardChannels, ch, client);
    this.server.monitors.delete(client);
  }

  /** PUBLISH: channel subscribers, then pattern subscribers; returns the number of receivers. */
  publish(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.server.channels.get(channel) ?? []) {
      client.write(new RespPush(['message', channel, message]));
      receivers++;
    }
    for (const [pattern, set] of this.server.patterns) {
      if (!matchGlob(pattern, channel)) continue;
      for (const client of set) {
        client.write(new RespPush(['pmessage', pattern, channel, message]));
        receivers++;
      }
    }
    return receivers;
  }

  spublish(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.server.shardChannels.get(channel) ?? []) {
      client.write(new RespPush(['smessage', channel, message]));
      receivers++;
    }
    return receivers;
  }
}
