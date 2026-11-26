import { differential, s, v } from './differential.harness';
import { pubsubChannel, sorted } from './differential.normalizers';

differential('pubsub', [
  // SUBSCRIBE / PUBLISH / UNSUBSCRIBE
  s('SUBSCRIBE replies', ['SUBSCRIBE a b', 'SUBSCRIBE a', 'SUBSCRIBE c']),
  s('SUBSCRIBE arity', ['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE']),
  s('PUBLISH delivers message', ['SUBSCRIBE news', { c: 1, cmd: 'PUBLISH news hello' }, { read: 1 }, { c: 1, cmd: 'PUBLISH other x' }]),
  s('PUBLISH counts receivers', ['SUBSCRIBE ch', { c: 1, cmd: 'SUBSCRIBE ch' }, { c: 2, cmd: 'PUBLISH ch m' }, { read: 1 }, { c: 1, read: 1 }]),
  s('PUBLISH binary payload and channel', ['SUBSCRIBE "c\\x00h"', { c: 1, cmd: 'PUBLISH "c\\x00h" "\\x00\\xff\\r\\n"' }, { read: 1 }]),
  s('PUBLISH empty message', ['SUBSCRIBE ch', { c: 1, cmd: 'PUBLISH ch ""' }, { read: 1 }]),
  s('PUBLISH arity', ['PUBLISH', 'PUBLISH ch', 'PUBLISH ch a b']),
  s('PUBLISH without subscribers', ['PUBLISH nobody msg']),
  s('UNSUBSCRIBE with args', ['SUBSCRIBE a b c', 'UNSUBSCRIBE a', 'UNSUBSCRIBE a x', 'UNSUBSCRIBE b c']),
  s('UNSUBSCRIBE without args', ['SUBSCRIBE a b', { cmd: 'UNSUBSCRIBE', replies: 2, norm: pubsubChannel }, 'UNSUBSCRIBE']),
  s('UNSUBSCRIBE when never subscribed', ['UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE', 'UNSUBSCRIBE x']),
  s('UNSUBSCRIBE keeps pattern count', ['SUBSCRIBE a', 'PSUBSCRIBE p*', 'UNSUBSCRIBE a', 'PUNSUBSCRIBE p*']),

  // PSUBSCRIBE
  s('PSUBSCRIBE and pmessage', ['PSUBSCRIBE news.* h?llo', { c: 1, cmd: 'PUBLISH news.tech x' }, { read: 1 }, { c: 1, cmd: 'PUBLISH hallo y' }, { read: 1 }]),
  s('channel and pattern both match', ['SUBSCRIBE news.a', 'PSUBSCRIBE news.*', { c: 1, cmd: 'PUBLISH news.a m' }, { read: 2 }]),
  s('overlapping patterns deliver twice', ['PSUBSCRIBE a* *', { c: 1, cmd: 'PUBLISH ab m' }, { read: 2, norm: pubsubChannel }]),
  s('PUNSUBSCRIBE without args', ['PSUBSCRIBE a* b*', { cmd: 'PUNSUBSCRIBE', replies: 2, norm: pubsubChannel }, 'PUNSUBSCRIBE']),
  s('PSUBSCRIBE glob classes', ['PSUBSCRIBE "[a-c]x" "\\\\*"', { c: 1, cmd: 'PUBLISH bx m' }, { read: 1 }, { c: 1, cmd: 'PUBLISH * star' }, { read: 1 }, { c: 1, cmd: 'PUBLISH dx m' }]),

  // sharded pub/sub
  s('SSUBSCRIBE and SPUBLISH', ['SSUBSCRIBE s1', { c: 1, cmd: 'SPUBLISH s1 hi' }, { read: 1 }, { c: 1, cmd: 'SPUBLISH s2 hi' }, 'SUNSUBSCRIBE s1']),
  s('SSUBSCRIBE multiple channels', ['SSUBSCRIBE a b', { cmd: 'SUNSUBSCRIBE', replies: 2, norm: pubsubChannel }]),
  s('SPUBLISH not seen by SUBSCRIBE', ['SUBSCRIBE ch', { c: 1, cmd: 'SPUBLISH ch m' }, { c: 1, cmd: 'PUBLISH ch m' }, { read: 1 }]),
  s('SPUBLISH arity', ['SPUBLISH', 'SPUBLISH ch']),

  // PUBSUB introspection
  s('PUBSUB CHANNELS', ['SUBSCRIBE news.a news.b other', { c: 1, cmd: 'PUBSUB CHANNELS', norm: sorted }, { c: 1, cmd: 'PUBSUB CHANNELS news.*', norm: sorted }, { c: 1, cmd: 'PUBSUB CHANNELS zzz' }]),
  s('PUBSUB NUMSUB', ['SUBSCRIBE a b', { c: 1, cmd: 'SUBSCRIBE a' }, { c: 2, cmd: 'PUBSUB NUMSUB a b c' }, { c: 2, cmd: 'PUBSUB NUMSUB' }]),
  s('PUBSUB NUMPAT', ['PSUBSCRIBE a* b*', { c: 1, cmd: 'PSUBSCRIBE a*' }, { c: 2, cmd: 'PUBSUB NUMPAT' }]),
  s('PUBSUB SHARDCHANNELS and SHARDNUMSUB', ['SSUBSCRIBE x y', { c: 1, cmd: 'PUBSUB SHARDCHANNELS', norm: sorted }, { c: 1, cmd: 'PUBSUB SHARDCHANNELS x*' }, { c: 1, cmd: 'PUBSUB SHARDNUMSUB x y z' }, { c: 1, cmd: 'PUBSUB SHARDNUMSUB' }]),
  s('PUBSUB empty server', ['PUBSUB CHANNELS', 'PUBSUB NUMPAT', 'PUBSUB SHARDCHANNELS', 'PUBSUB NUMSUB x']),
  s('PUBSUB errors', ['PUBSUB', 'PUBSUB FOO', 'PUBSUB CHANNELS a b', 'PUBSUB NUMPAT x', 'PUBSUB SHARDCHANNELS a b']),
  s('PUBSUB HELP', ['PUBSUB HELP'], v('the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")', 'medium')),
  s('PUBSUB counts drop after disconnect', [{ c: 1, cmd: 'SUBSCRIBE a' }, { c: 1, cmd: 'UNSUBSCRIBE a' }, 'PUBSUB CHANNELS', 'PUBLISH a x']),

  // subscribed mode
  s('RESP2 subscribed mode rejects commands', ['SUBSCRIBE a', 'GET k', 'SET k v', 'MULTI', 'PUBLISH a x', 'CLIENT ID'], { proto: 2 }),
  s('RESP2 subscribed mode allowed commands', ['SUBSCRIBE a', 'PSUBSCRIBE p*', 'SSUBSCRIBE s', 'PUNSUBSCRIBE p*', 'SUNSUBSCRIBE s', 'UNSUBSCRIBE a', 'GET k'], { proto: 2 }),
  s('RESP2 subscribed via PSUBSCRIBE only', ['PSUBSCRIBE p*', 'ECHO x'], { proto: 2 }),
  s('RESP2 subscribed via SSUBSCRIBE only', ['SSUBSCRIBE s', 'ECHO x'], { proto: 2 }),
  s('RESP3 subscribed mode allows commands', ['SUBSCRIBE a', 'SET k v', 'GET k', { c: 1, cmd: 'PUBLISH a m' }, { read: 1 }, 'GET k'], { proto: 3 }),
  s('PING in subscribed mode', ['SUBSCRIBE a', 'PING', 'PING hello', 'PING a b']),
  s('PING outside subscribed mode', ['PING', 'PING hello']),
  s('RESET leaves subscribed mode', ['SUBSCRIBE a', 'PSUBSCRIBE p*', 'RESET', 'GET k', { c: 1, cmd: 'PUBSUB CHANNELS' }, { c: 1, cmd: 'PUBSUB NUMPAT' }]),
  s('unknown command in subscribed mode', ['SUBSCRIBE a', 'NOSUCHCMD x']),
  s('wrong arity in subscribed mode', ['SUBSCRIBE a', 'GET']),
  s('SUBSCRIBE inside MULTI', ['MULTI', 'SUBSCRIBE a', 'EXEC']),
  s('PUBLISH inside MULTI', ['SUBSCRIBE a', { c: 1, cmd: 'MULTI' }, { c: 1, cmd: 'PUBLISH a 1' }, { c: 1, cmd: 'PUBLISH a 2' }, { c: 1, cmd: 'EXEC' }, { read: 2 }]),
  s('PUBLISH from Lua', ['SUBSCRIBE a', { c: 1, cmd: ['EVAL', "return redis.call('PUBLISH', 'a', 'lua')", '0'] }, { read: 1 }]),

  // keyspace notifications
  s('keyspace notifications', ['CONFIG SET notify-keyspace-events KEA', 'PSUBSCRIBE __key*@0__:*', { c: 1, cmd: 'SET k v' }, { read: 2 }, { c: 1, cmd: 'DEL k' }, { read: 2 }]),
  s('keyevent notifications for list ops', ['CONFIG SET notify-keyspace-events El', 'PSUBSCRIBE __keyevent@0__:*', { c: 1, cmd: 'RPUSH l a b' }, { c: 1, cmd: 'LPOP l' }, { read: 2 }]),
  s('keyspace notifications for expiry', ['CONFIG SET notify-keyspace-events Kx', 'PSUBSCRIBE __keyspace@0__:*', { c: 1, cmd: 'SET k v PX 20' }, { read: 1, timeout: 3000 }]),
  s('notify-keyspace-events config value', ['CONFIG SET notify-keyspace-events KEA', 'CONFIG GET notify-keyspace-events', 'CONFIG SET notify-keyspace-events Elg$', 'CONFIG GET notify-keyspace-events', 'CONFIG SET notify-keyspace-events Q']),
]);
